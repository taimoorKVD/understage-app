//! OpenMLS session used by the Understage Expo module (Phase 1).
//!
//! Ciphersuite: MLS_128_DHKEMX25519_AES128GCM_SHA256_Ed25519 (RFC 9420 MTI).
//! Persistence: openmls_sqlite_storage (rusqlite bundled) plus an AES-256-GCM
//! vault next to the sqlite file, sealed with a 32-byte wrapping key that the
//! Swift layer loads from the iOS Keychain.

use std::fs;
use std::path::{Path, PathBuf};
use std::sync::Mutex;

use aes_gcm::aead::{Aead, KeyInit, OsRng, rand_core::RngCore};
use aes_gcm::{Aes256Gcm, Nonce};
use openmls::prelude::tls_codec::{Deserialize as TlsDeserialize, Serialize as TlsSerialize};
use openmls::prelude::*;
use openmls_basic_credential::SignatureKeyPair;
use openmls_rust_crypto::RustCrypto;
use openmls_sqlite_storage::{Codec, Connection, SqliteStorageProvider};
use openmls_traits::OpenMlsProvider;
use serde::de::DeserializeOwned;
use serde::{Deserialize, Serialize};

uniffi::setup_scaffolding!();

/// The RFC 9420 mandatory-to-implement ciphersuite chosen in the plan.
pub const CIPHERSUITE: Ciphersuite = Ciphersuite::MLS_128_DHKEMX25519_AES128GCM_SHA256_Ed25519;

const VAULT_MAGIC: &str = "understage-mls-v1";

#[derive(Debug, Clone, thiserror::Error, uniffi::Error)]
pub enum MlsError {
    #[error("{reason}")]
    Failed { reason: String },
}

impl MlsError {
    fn failed(reason: impl ToString) -> Self {
        Self::Failed {
            reason: reason.to_string(),
        }
    }
}

#[uniffi::export]
pub fn ciphersuite_name() -> String {
    "MLS_128_DHKEMX25519_AES128GCM_SHA256_Ed25519".to_string()
}

/// serde_json codec for `openmls_sqlite_storage`.
#[derive(Default, Clone, Copy)]
pub struct JsonCodec;

impl Codec for JsonCodec {
    type Error = serde_json::Error;

    fn to_vec<T: Serialize>(value: &T) -> Result<Vec<u8>, Self::Error> {
        serde_json::to_vec(value)
    }

    fn from_slice<T: DeserializeOwned>(slice: &[u8]) -> Result<T, Self::Error> {
        serde_json::from_slice(slice)
    }
}

/// OpenMLS provider: RustCrypto + a sqlite file (rusqlite bundled).
pub struct MlsProvider {
    crypto: RustCrypto,
    storage: SqliteStorageProvider<JsonCodec, Connection>,
}

impl MlsProvider {
    pub fn open(path: impl AsRef<Path>) -> Result<Self, MlsError> {
        let path = path.as_ref();
        if let Some(parent) = path.parent() {
            if !parent.as_os_str().is_empty() {
                fs::create_dir_all(parent).map_err(MlsError::failed)?;
            }
        }
        let conn = Connection::open(path).map_err(MlsError::failed)?;
        let mut storage = SqliteStorageProvider::<JsonCodec, Connection>::new(conn);
        storage
            .run_migrations()
            .map_err(MlsError::failed)?;
        Ok(Self {
            crypto: RustCrypto::default(),
            storage,
        })
    }
}

impl OpenMlsProvider for MlsProvider {
    type CryptoProvider = RustCrypto;
    type RandProvider = RustCrypto;
    type StorageProvider = SqliteStorageProvider<JsonCodec, Connection>;

    fn storage(&self) -> &Self::StorageProvider {
        &self.storage
    }

    fn crypto(&self) -> &Self::CryptoProvider {
        &self.crypto
    }

    fn rand(&self) -> &Self::RandProvider {
        &self.crypto
    }
}

#[derive(Serialize, Deserialize)]
struct PersistedIdentity {
    magic: String,
    identity: String,
    signer: SignatureKeyPair,
    group_id: Option<Vec<u8>>,
}

struct SessionInner {
    storage_path: PathBuf,
    wrapping_key: Vec<u8>,
    provider: MlsProvider,
    identity: Option<String>,
    credential: Option<CredentialWithKey>,
    signer: Option<SignatureKeyPair>,
    group: Option<MlsGroup>,
}

impl SessionInner {
    fn vault_path(&self) -> PathBuf {
        let mut p = self.storage_path.as_os_str().to_os_string();
        p.push(".vault");
        PathBuf::from(p)
    }

    fn persist_vault(&self) -> Result<(), MlsError> {
        let signer = self
            .signer
            .as_ref()
            .ok_or_else(|| MlsError::failed("no credential to persist"))?;
        let identity = self
            .identity
            .as_ref()
            .ok_or_else(|| MlsError::failed("no identity to persist"))?;
        let blob = PersistedIdentity {
            magic: VAULT_MAGIC.to_string(),
            identity: identity.clone(),
            signer: signer.clone(),
            group_id: self.group.as_ref().map(|g| g.group_id().to_vec()),
        };
        let plaintext = serde_json::to_vec(&blob).map_err(MlsError::failed)?;
        let sealed = seal(&self.wrapping_key, &plaintext)?;
        fs::write(self.vault_path(), sealed).map_err(MlsError::failed)
    }

    fn group_config() -> MlsGroupCreateConfig {
        MlsGroupCreateConfig::builder()
            .ciphersuite(CIPHERSUITE)
            .use_ratchet_tree_extension(true)
            .build()
    }

    fn require_identity(&self) -> Result<(&CredentialWithKey, &SignatureKeyPair), MlsError> {
        let cred = self
            .credential
            .as_ref()
            .ok_or_else(|| MlsError::failed("generate a credential first"))?;
        let signer = self
            .signer
            .as_ref()
            .ok_or_else(|| MlsError::failed("generate a credential first"))?;
        Ok((cred, signer))
    }

    fn current_epoch(&self) -> Result<u64, MlsError> {
        Ok(self
            .group
            .as_ref()
            .ok_or_else(|| MlsError::failed("no group; create or join first"))?
            .epoch()
            .as_u64())
    }
}

fn seal(key: &[u8], plaintext: &[u8]) -> Result<Vec<u8>, MlsError> {
    if key.len() != 32 {
        return Err(MlsError::failed("wrapping key must be 32 bytes"));
    }
    let cipher = Aes256Gcm::new_from_slice(key).map_err(MlsError::failed)?;
    let mut nonce = [0u8; 12];
    OsRng.fill_bytes(&mut nonce);
    let ct = cipher
        .encrypt(Nonce::from_slice(&nonce), plaintext)
        .map_err(|e| MlsError::failed(format!("wrap: {e}")))?;
    let mut out = nonce.to_vec();
    out.extend(ct);
    Ok(out)
}

fn open_seal(key: &[u8], blob: &[u8]) -> Result<Vec<u8>, MlsError> {
    if key.len() != 32 {
        return Err(MlsError::failed("wrapping key must be 32 bytes"));
    }
    if blob.len() < 13 {
        return Err(MlsError::failed("wrapped vault is too short"));
    }
    let cipher = Aes256Gcm::new_from_slice(key).map_err(MlsError::failed)?;
    cipher
        .decrypt(Nonce::from_slice(&blob[..12]), &blob[12..])
        .map_err(|_| MlsError::failed("wrong wrapping key or corrupt vault"))
}

fn serialize_msg(msg: &MlsMessageOut) -> Result<Vec<u8>, MlsError> {
    msg.tls_serialize_detached()
        .map_err(|e| MlsError::failed(format!("tls serialize: {e}")))
}

fn parse_msg(bytes: &[u8]) -> Result<MlsMessageIn, MlsError> {
    MlsMessageIn::tls_deserialize_exact(bytes)
        .map_err(|e| MlsError::failed(format!("tls deserialize: {e}")))
}

fn into_protocol(bytes: &[u8]) -> Result<ProtocolMessage, MlsError> {
    parse_msg(bytes)?
        .try_into_protocol_message()
        .map_err(|e| MlsError::failed(format!("not a protocol message: {e}")))
}

fn hex_bytes(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

#[derive(uniffi::Record)]
pub struct AddMemberResult {
    pub commit: Vec<u8>,
    pub welcome: Vec<u8>,
    pub epoch: u64,
}

#[derive(uniffi::Record)]
pub struct RemoveMemberResult {
    pub commit: Vec<u8>,
    pub epoch: u64,
}

#[derive(uniffi::Record)]
pub struct ProcessResult {
    pub kind: String,
    pub plaintext: Option<Vec<u8>>,
    pub epoch: u64,
}

#[derive(uniffi::Object)]
pub struct MlsSession {
    inner: Mutex<SessionInner>,
}

#[uniffi::export]
impl MlsSession {
    #[uniffi::constructor]
    pub fn open(storage_path: String, wrapping_key: Vec<u8>) -> Result<std::sync::Arc<Self>, MlsError> {
        if wrapping_key.len() != 32 {
            return Err(MlsError::failed("wrapping key must be 32 bytes"));
        }
        let storage_path = PathBuf::from(storage_path);
        let provider = MlsProvider::open(&storage_path)?;
        let mut inner = SessionInner {
            storage_path,
            wrapping_key: wrapping_key.clone(),
            provider,
            identity: None,
            credential: None,
            signer: None,
            group: None,
        };

        let vault_path = inner.vault_path();
        if vault_path.exists() {
            let sealed = fs::read(&vault_path).map_err(MlsError::failed)?;
            let plain = open_seal(&wrapping_key, &sealed)?;
            let stored: PersistedIdentity =
                serde_json::from_slice(&plain).map_err(MlsError::failed)?;
            if stored.magic != VAULT_MAGIC {
                return Err(MlsError::failed("vault magic mismatch"));
            }
            stored
                .signer
                .store(inner.provider.storage())
                .map_err(MlsError::failed)?;
            let credential = BasicCredential::new(stored.identity.as_bytes().to_vec());
            inner.credential = Some(CredentialWithKey {
                credential: credential.into(),
                signature_key: stored.signer.public().into(),
            });
            inner.identity = Some(stored.identity);
            if let Some(gid) = stored.group_id.as_ref() {
                let group_id = GroupId::from_slice(gid);
                inner.group = MlsGroup::load(inner.provider.storage(), &group_id)
                    .map_err(MlsError::failed)?;
            }
            inner.signer = Some(stored.signer);
        }

        Ok(std::sync::Arc::new(Self {
            inner: Mutex::new(inner),
        }))
    }

    pub fn generate_credential(&self, identity: String) -> Result<(), MlsError> {
        let mut inner = self.inner.lock().map_err(|e| MlsError::failed(e.to_string()))?;
        if identity.is_empty() {
            return Err(MlsError::failed("identity must not be empty"));
        }
        let signer = SignatureKeyPair::new(CIPHERSUITE.signature_algorithm())
            .map_err(MlsError::failed)?;
        signer
            .store(inner.provider.storage())
            .map_err(MlsError::failed)?;
        let credential = BasicCredential::new(identity.as_bytes().to_vec());
        inner.credential = Some(CredentialWithKey {
            credential: credential.into(),
            signature_key: signer.public().into(),
        });
        inner.signer = Some(signer);
        inner.identity = Some(identity);
        inner.persist_vault()
    }

    pub fn export_key_package(&self) -> Result<Vec<u8>, MlsError> {
        let inner = self.inner.lock().map_err(|e| MlsError::failed(e.to_string()))?;
        let (cred, signer) = inner.require_identity()?;
        let bundle = KeyPackage::builder()
            .build(CIPHERSUITE, &inner.provider, signer, cred.clone())
            .map_err(MlsError::failed)?;
        let msg = MlsMessageOut::from(bundle.key_package().clone());
        serialize_msg(&msg)
    }

    pub fn create_group(&self) -> Result<String, MlsError> {
        let mut inner = self.inner.lock().map_err(|e| MlsError::failed(e.to_string()))?;
        if inner.group.is_some() {
            return Err(MlsError::failed("a group is already loaded in this session"));
        }
        let config = SessionInner::group_config();
        let (cred, signer) = inner.require_identity()?;
        let group = MlsGroup::new(&inner.provider, signer, &config, cred.clone())
            .map_err(MlsError::failed)?;
        let id_hex = hex_bytes(group.group_id().as_slice());
        inner.group = Some(group);
        inner.persist_vault()?;
        Ok(id_hex)
    }

    pub fn add_member(&self, key_package: Vec<u8>) -> Result<AddMemberResult, MlsError> {
        let mut inner = self.inner.lock().map_err(|e| MlsError::failed(e.to_string()))?;
        let parsed = parse_msg(&key_package)?;
        let kp = match parsed.extract() {
            MlsMessageBodyIn::KeyPackage(kp_in) => kp_in
                .validate(inner.provider.crypto(), ProtocolVersion::Mls10)
                .map_err(MlsError::failed)?,
            other => {
                return Err(MlsError::failed(format!(
                    "expected a KeyPackage, got {other:?}"
                )))
            }
        };
        let (commit, welcome, epoch) = {
            let SessionInner {
                provider,
                group,
                signer,
                ..
            } = &mut *inner;
            let signer = signer
                .as_ref()
                .ok_or_else(|| MlsError::failed("generate a credential first"))?;
            let group = group
                .as_mut()
                .ok_or_else(|| MlsError::failed("no group; create or join first"))?;
            let (commit, welcome, _info) = group
                .add_members(provider, signer, core::slice::from_ref(&kp))
                .map_err(MlsError::failed)?;
            group
                .merge_pending_commit(provider)
                .map_err(MlsError::failed)?;
            (commit, welcome, group.epoch().as_u64())
        };
        let result = AddMemberResult {
            commit: serialize_msg(&commit)?,
            welcome: serialize_msg(&welcome)?,
            epoch,
        };
        inner.persist_vault()?;
        Ok(result)
    }

    pub fn join_from_welcome(&self, welcome: Vec<u8>) -> Result<u64, MlsError> {
        let mut inner = self.inner.lock().map_err(|e| MlsError::failed(e.to_string()))?;
        if inner.group.is_some() {
            return Err(MlsError::failed("a group is already loaded in this session"));
        }
        let _ = inner.require_identity()?;
        let parsed = parse_msg(&welcome)?;
        let welcome = match parsed.extract() {
            MlsMessageBodyIn::Welcome(w) => w,
            other => {
                return Err(MlsError::failed(format!(
                    "expected a Welcome, got {other:?}"
                )))
            }
        };
        let join_config = SessionInner::group_config().join_config().clone();
        let staged = StagedWelcome::new_from_welcome(
            &inner.provider,
            &join_config,
            welcome,
            None,
        )
        .map_err(MlsError::failed)?;
        let group = staged.into_group(&inner.provider).map_err(MlsError::failed)?;
        let epoch = group.epoch().as_u64();
        inner.group = Some(group);
        inner.persist_vault()?;
        Ok(epoch)
    }

    pub fn process_incoming(&self, message: Vec<u8>) -> Result<ProcessResult, MlsError> {
        let mut inner = self.inner.lock().map_err(|e| MlsError::failed(e.to_string()))?;
        let proto = into_protocol(&message)?;
        let processed = {
            let SessionInner { provider, group, .. } = &mut *inner;
            let group = group
                .as_mut()
                .ok_or_else(|| MlsError::failed("no group; create or join first"))?;
            group
                .process_message(provider, proto)
                .map_err(MlsError::failed)?
        };
        match processed.into_content() {
            ProcessedMessageContent::ApplicationMessage(application) => {
                let epoch = inner.current_epoch()?;
                Ok(ProcessResult {
                    kind: "application".to_string(),
                    plaintext: Some(application.into_bytes()),
                    epoch,
                })
            }
            ProcessedMessageContent::StagedCommitMessage(staged) => {
                {
                    let SessionInner { provider, group, .. } = &mut *inner;
                    let group = group
                        .as_mut()
                        .ok_or_else(|| MlsError::failed("no group; create or join first"))?;
                    group
                        .merge_staged_commit(provider, *staged)
                        .map_err(MlsError::failed)?;
                }
                let epoch = inner.current_epoch()?;
                inner.persist_vault()?;
                Ok(ProcessResult {
                    kind: "commit".to_string(),
                    plaintext: None,
                    epoch,
                })
            }
            _ => {
                let epoch = inner.current_epoch()?;
                Ok(ProcessResult {
                    kind: "other".to_string(),
                    plaintext: None,
                    epoch,
                })
            }
        }
    }

    pub fn encrypt(&self, plaintext: Vec<u8>) -> Result<Vec<u8>, MlsError> {
        let mut inner = self.inner.lock().map_err(|e| MlsError::failed(e.to_string()))?;
        let msg = {
            let SessionInner {
                provider,
                group,
                signer,
                ..
            } = &mut *inner;
            let signer = signer
                .as_ref()
                .ok_or_else(|| MlsError::failed("generate a credential first"))?;
            let group = group
                .as_mut()
                .ok_or_else(|| MlsError::failed("no group; create or join first"))?;
            group
                .create_message(provider, signer, &plaintext)
                .map_err(MlsError::failed)?
        };
        serialize_msg(&msg)
    }

    pub fn decrypt(&self, ciphertext: Vec<u8>) -> Result<Vec<u8>, MlsError> {
        let processed = self.process_incoming(ciphertext)?;
        if processed.kind != "application" {
            return Err(MlsError::failed(format!(
                "expected an application message, got {}",
                processed.kind
            )));
        }
        processed
            .plaintext
            .ok_or_else(|| MlsError::failed("application message had no plaintext"))
    }

    pub fn remove_member(&self, identity: String) -> Result<RemoveMemberResult, MlsError> {
        let mut inner = self.inner.lock().map_err(|e| MlsError::failed(e.to_string()))?;
        let index = {
            let group = inner
                .group
                .as_ref()
                .ok_or_else(|| MlsError::failed("no group; create or join first"))?;
            group
                .members()
                .find(|member| member.credential.serialized_content() == identity.as_bytes())
                .map(|member| member.index)
                .ok_or_else(|| MlsError::failed(format!("no member named {identity}")))?
        };
        let (commit, epoch) = {
            let SessionInner {
                provider,
                group,
                signer,
                ..
            } = &mut *inner;
            let signer = signer
                .as_ref()
                .ok_or_else(|| MlsError::failed("generate a credential first"))?;
            let group = group
                .as_mut()
                .ok_or_else(|| MlsError::failed("no group; create or join first"))?;
            let (commit, _maybe_welcome, _info) = group
                .remove_members(provider, signer, &[index])
                .map_err(MlsError::failed)?;
            group
                .merge_pending_commit(provider)
                .map_err(MlsError::failed)?;
            (commit, group.epoch().as_u64())
        };
        let result = RemoveMemberResult {
            commit: serialize_msg(&commit)?,
            epoch,
        };
        inner.persist_vault()?;
        Ok(result)
    }

    pub fn epoch(&self) -> Result<u64, MlsError> {
        let inner = self.inner.lock().map_err(|e| MlsError::failed(e.to_string()))?;
        inner.current_epoch()
    }
}
