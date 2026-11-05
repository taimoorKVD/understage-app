//! Phase 0 host round-trip: credentials, KeyPackage, group, Welcome,
//! application messages both ways, add + remove of a third member, then
//! sqlite persist and reload.

use std::path::PathBuf;

use mls_poc::{ciphersuite_name, MlsProvider, CIPHERSUITE};
use openmls::prelude::*;
use openmls_basic_credential::SignatureKeyPair;

fn db_path(label: &str) -> PathBuf {
    let stamp = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap()
        .as_nanos();
    let path = std::env::temp_dir().join(format!(
        "understage-mls-poc-{}-{}-{}.sqlite",
        std::process::id(),
        stamp,
        label
    ));
    let _ = std::fs::remove_file(&path);
    path
}

fn generate_identity(
    identity: &[u8],
    provider: &MlsProvider,
) -> (CredentialWithKey, SignatureKeyPair) {
    let credential = BasicCredential::new(identity.to_vec());
    let signer = SignatureKeyPair::new(CIPHERSUITE.signature_algorithm())
        .expect("generate Ed25519 signature key pair");
    signer
        .store(provider.storage())
        .expect("store signature key pair");
    let credential_with_key = CredentialWithKey {
        credential: credential.into(),
        signature_key: signer.public().into(),
    };
    (credential_with_key, signer)
}

fn generate_key_package(
    provider: &MlsProvider,
    signer: &SignatureKeyPair,
    credential_with_key: CredentialWithKey,
) -> KeyPackage {
    KeyPackage::builder()
        .build(CIPHERSUITE, provider, signer, credential_with_key)
        .expect("build KeyPackage")
        .key_package()
        .clone()
}

fn create_config() -> MlsGroupCreateConfig {
    MlsGroupCreateConfig::builder()
        .ciphersuite(CIPHERSUITE)
        .use_ratchet_tree_extension(true)
        .build()
}

fn into_protocol(message: MlsMessageOut) -> ProtocolMessage {
    let message_in: MlsMessageIn = message.into();
    message_in
        .try_into_protocol_message()
        .expect("handshake or application ProtocolMessage")
}

fn into_welcome(message: MlsMessageOut) -> Welcome {
    let message_in: MlsMessageIn = message.into();
    match message_in.extract() {
        MlsMessageBodyIn::Welcome(welcome) => welcome,
        other => panic!("expected Welcome, got {other:?}"),
    }
}

fn decrypt_application(
    group: &mut MlsGroup,
    provider: &MlsProvider,
    message: MlsMessageOut,
) -> Vec<u8> {
    let processed = group
        .process_message(provider, into_protocol(message))
        .expect("process application message");
    match processed.into_content() {
        ProcessedMessageContent::ApplicationMessage(application) => application.into_bytes(),
        _ => panic!("expected an application message"),
    }
}

fn merge_incoming_commit(group: &mut MlsGroup, provider: &MlsProvider, message: MlsMessageOut) {
    let processed = group
        .process_message(provider, into_protocol(message))
        .expect("process commit");
    match processed.into_content() {
        ProcessedMessageContent::StagedCommitMessage(staged) => {
            group
                .merge_staged_commit(provider, *staged)
                .expect("merge staged commit");
        }
        _ => panic!("expected a staged commit"),
    }
}

fn join_from_welcome(
    provider: &MlsProvider,
    join_config: &MlsGroupJoinConfig,
    welcome: MlsMessageOut,
) -> MlsGroup {
    let staged = StagedWelcome::new_from_welcome(
        provider,
        join_config,
        into_welcome(welcome),
        None,
    )
    .expect("stage Welcome");
    staged.into_group(provider).expect("join from Welcome")
}

#[test]
fn alice_bob_charlie_roundtrip_and_reload() {
    assert_eq!(
        ciphersuite_name(),
        "MLS_128_DHKEMX25519_AES128GCM_SHA256_Ed25519"
    );

    let alice_db = db_path("alice");
    let bob_db = db_path("bob");
    let charlie_db = db_path("charlie");

    let alice_provider = MlsProvider::open(&alice_db);
    let bob_provider = MlsProvider::open(&bob_db);
    let charlie_provider = MlsProvider::open(&charlie_db);

    let (alice_cred, alice_signer) = generate_identity(b"alice", &alice_provider);
    let (bob_cred, bob_signer) = generate_identity(b"bob", &bob_provider);
    let (charlie_cred, charlie_signer) = generate_identity(b"charlie", &charlie_provider);

    // Bob publishes a KeyPackage (private parts stay in his sqlite provider).
    let bob_key_package = generate_key_package(&bob_provider, &bob_signer, bob_cred);
    let charlie_key_package = generate_key_package(&charlie_provider, &charlie_signer, charlie_cred);

    let group_config = create_config();
    let join_config = group_config.join_config().clone();

    let mut alice_group = MlsGroup::new(
        &alice_provider,
        &alice_signer,
        &group_config,
        alice_cred,
    )
    .expect("Alice creates the group");
    let group_id = alice_group.group_id().clone();

    let (add_bob_commit, bob_welcome, _info) = alice_group
        .add_members(
            &alice_provider,
            &alice_signer,
            core::slice::from_ref(&bob_key_package),
        )
        .expect("Alice adds Bob");
    let _ = add_bob_commit;
    alice_group
        .merge_pending_commit(&alice_provider)
        .expect("Alice merges add-Bob commit");

    let mut bob_group = join_from_welcome(&bob_provider, &join_config, bob_welcome);
    assert_eq!(alice_group.epoch(), bob_group.epoch());
    assert_eq!(alice_group.members().count(), 2);
    assert_eq!(bob_group.members().count(), 2);

    let hello = alice_group
        .create_message(&alice_provider, &alice_signer, b"hello from alice")
        .expect("Alice encrypts");
    assert_eq!(
        decrypt_application(&mut bob_group, &bob_provider, hello),
        b"hello from alice"
    );

    let reply = bob_group
        .create_message(&bob_provider, &bob_signer, b"hello from bob")
        .expect("Bob encrypts");
    assert_eq!(
        decrypt_application(&mut alice_group, &alice_provider, reply),
        b"hello from bob"
    );

    let (add_charlie_commit, charlie_welcome, _info) = alice_group
        .add_members(
            &alice_provider,
            &alice_signer,
            core::slice::from_ref(&charlie_key_package),
        )
        .expect("Alice adds Charlie");
    alice_group
        .merge_pending_commit(&alice_provider)
        .expect("Alice merges add-Charlie commit");
    merge_incoming_commit(&mut bob_group, &bob_provider, add_charlie_commit);

    let mut charlie_group = join_from_welcome(&charlie_provider, &join_config, charlie_welcome);
    assert_eq!(alice_group.members().count(), 3);
    assert_eq!(bob_group.members().count(), 3);
    assert_eq!(charlie_group.members().count(), 3);

    let three = alice_group
        .create_message(&alice_provider, &alice_signer, b"three of us")
        .expect("Alice encrypts to three");
    assert_eq!(
        decrypt_application(&mut bob_group, &bob_provider, three.clone()),
        b"three of us"
    );
    assert_eq!(
        decrypt_application(&mut charlie_group, &charlie_provider, three),
        b"three of us"
    );

    let charlie_index = alice_group
        .members()
        .find(|member| member.credential.serialized_content() == b"charlie")
        .map(|member| member.index)
        .expect("Charlie leaf index");

    let (remove_commit, _maybe_welcome, _info) = alice_group
        .remove_members(&alice_provider, &alice_signer, &[charlie_index])
        .expect("Alice removes Charlie");
    alice_group
        .merge_pending_commit(&alice_provider)
        .expect("Alice merges remove-Charlie commit");
    merge_incoming_commit(&mut bob_group, &bob_provider, remove_commit.clone());
    merge_incoming_commit(&mut charlie_group, &charlie_provider, remove_commit);

    assert!(!charlie_group.is_active(), "removed member must be inactive");
    assert_eq!(alice_group.members().count(), 2);
    assert_eq!(bob_group.members().count(), 2);

    let after_remove = alice_group
        .create_message(&alice_provider, &alice_signer, b"charlie is gone")
        .expect("Alice encrypts after remove");
    assert_eq!(
        decrypt_application(&mut bob_group, &bob_provider, after_remove.clone()),
        b"charlie is gone"
    );
    let charlie_after = charlie_group.process_message(&charlie_provider, into_protocol(after_remove));
    assert!(
        charlie_after.is_err(),
        "removed member must not decrypt a new message: {charlie_after:?}"
    );

    // Persist + reload: drop in-memory groups, reopen the same sqlite files.
    drop(alice_group);
    drop(bob_group);
    drop(alice_provider);
    drop(bob_provider);

    let alice_provider = MlsProvider::open(&alice_db);
    let bob_provider = MlsProvider::open(&bob_db);
    let mut alice_group = MlsGroup::load(alice_provider.storage(), &group_id)
        .expect("alice load")
        .expect("alice group present in sqlite");
    let mut bob_group = MlsGroup::load(bob_provider.storage(), &group_id)
        .expect("bob load")
        .expect("bob group present in sqlite");

    let after_reload = alice_group
        .create_message(&alice_provider, &alice_signer, b"after reload")
        .expect("Alice encrypts after reload");
    assert_eq!(
        decrypt_application(&mut bob_group, &bob_provider, after_reload),
        b"after reload"
    );

    let _ = std::fs::remove_file(&alice_db);
    let _ = std::fs::remove_file(&bob_db);
    let _ = std::fs::remove_file(&charlie_db);
}
