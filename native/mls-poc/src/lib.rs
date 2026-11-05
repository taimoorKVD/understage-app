//! Throwaway OpenMLS Phase 0 helpers.
//!
//! Real protocol coverage lives in `tests/mls_roundtrip.rs`. This library
//! exists so `cargo test` and `cargo build --release --target *-apple-ios`
//! share the same crate, and so a later UniFFI check can export one symbol.

use std::path::Path;

use openmls::prelude::*;
use openmls_rust_crypto::RustCrypto;
use openmls_sqlite_storage::{Codec, Connection, SqliteStorageProvider};
use openmls_traits::OpenMlsProvider;
use serde::de::DeserializeOwned;
use serde::Serialize;

/// The RFC 9420 mandatory-to-implement ciphersuite chosen in the plan.
pub const CIPHERSUITE: Ciphersuite = Ciphersuite::MLS_128_DHKEMX25519_AES128GCM_SHA256_Ed25519;

pub fn ciphersuite_name() -> &'static str {
    "MLS_128_DHKEMX25519_AES128GCM_SHA256_Ed25519"
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
    pub fn open(path: impl AsRef<Path>) -> Self {
        let conn = Connection::open(path.as_ref()).expect("open sqlite");
        let mut storage = SqliteStorageProvider::<JsonCodec, Connection>::new(conn);
        storage
            .run_migrations()
            .expect("openmls_sqlite_storage migrations");
        Self {
            crypto: RustCrypto::default(),
            storage,
        }
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
