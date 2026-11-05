//! Phase 3 host tests: add/remove secrecy, attachment content keys,
//! epoch catch-up after a delayed commit, and a 200-member batch add.

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
        "understage-mls-p3-{}-{}-{}.sqlite",
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
fn new_member_cannot_read_old_messages_but_can_read_new_ones() {
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
    let bob_kp = generate_key_package(&bob_provider, &bob_signer, bob_cred);
    let charlie_kp = generate_key_package(&charlie_provider, &charlie_signer, charlie_cred);

    let group_config = create_config();
    let join_config = group_config.join_config().clone();
    let mut alice_group =
        MlsGroup::new(&alice_provider, &alice_signer, &group_config, alice_cred)
            .expect("create");
    let (add_bob, bob_welcome, _) = alice_group
        .add_members(&alice_provider, &alice_signer, core::slice::from_ref(&bob_kp))
        .expect("add bob");
    let _ = add_bob;
    alice_group
        .merge_pending_commit(&alice_provider)
        .expect("merge bob");
    let mut bob_group = join_from_welcome(&bob_provider, &join_config, bob_welcome);

    let prior = alice_group
        .create_message(&alice_provider, &alice_signer, b"before charlie")
        .expect("prior message");
    assert_eq!(
        decrypt_application(&mut bob_group, &bob_provider, prior.clone()),
        b"before charlie"
    );

    let (add_charlie, charlie_welcome, _) = alice_group
        .add_members(
            &alice_provider,
            &alice_signer,
            core::slice::from_ref(&charlie_kp),
        )
        .expect("add charlie");
    alice_group
        .merge_pending_commit(&alice_provider)
        .expect("merge charlie");
    merge_incoming_commit(&mut bob_group, &bob_provider, add_charlie);
    let mut charlie_group = join_from_welcome(&charlie_provider, &join_config, charlie_welcome);

    let charlie_old = charlie_group.process_message(&charlie_provider, into_protocol(prior));
    assert!(
        charlie_old.is_err(),
        "new member must not decrypt a message from before they joined: {charlie_old:?}"
    );

    let after = alice_group
        .create_message(&alice_provider, &alice_signer, b"after charlie")
        .expect("after message");
    assert_eq!(
        decrypt_application(&mut bob_group, &bob_provider, after.clone()),
        b"after charlie"
    );
    assert_eq!(
        decrypt_application(&mut charlie_group, &charlie_provider, after),
        b"after charlie"
    );

    let _ = std::fs::remove_file(&alice_db);
    let _ = std::fs::remove_file(&bob_db);
    let _ = std::fs::remove_file(&charlie_db);
}

#[test]
fn attachment_content_key_travels_in_one_application_message() {
    let alice_db = db_path("att-a");
    let bob_db = db_path("att-b");
    let alice_provider = MlsProvider::open(&alice_db);
    let bob_provider = MlsProvider::open(&bob_db);
    let (alice_cred, alice_signer) = generate_identity(b"alice", &alice_provider);
    let (bob_cred, bob_signer) = generate_identity(b"bob", &bob_provider);
    let bob_kp = generate_key_package(&bob_provider, &bob_signer, bob_cred);
    let group_config = create_config();
    let join_config = group_config.join_config().clone();
    let mut alice_group =
        MlsGroup::new(&alice_provider, &alice_signer, &group_config, alice_cred)
            .expect("create");
    let (_, bob_welcome, _) = alice_group
        .add_members(&alice_provider, &alice_signer, core::slice::from_ref(&bob_kp))
        .expect("add bob");
    alice_group
        .merge_pending_commit(&alice_provider)
        .expect("merge");
    let mut bob_group = join_from_welcome(&bob_provider, &join_config, bob_welcome);

    // Same shape the app stores: encrypted blob key inside the MLS plaintext.
    let payload = br#"{"v":1,"type":"image","attachment":{"id":"att_1","key":"file-key","nonce":"file-nonce","mime":"image/jpeg","name":"cue.jpg","size":12},"sentAt":1}"#;
    let sealed = alice_group
        .create_message(&alice_provider, &alice_signer, payload)
        .expect("encrypt attachment descriptor");
    assert_eq!(
        decrypt_application(&mut bob_group, &bob_provider, sealed),
        payload
    );

    let _ = std::fs::remove_file(&alice_db);
    let _ = std::fs::remove_file(&bob_db);
}

#[test]
fn delayed_commit_is_applied_on_catch_up() {
    let alice_db = db_path("cu-a");
    let bob_db = db_path("cu-b");
    let alice_provider = MlsProvider::open(&alice_db);
    let bob_provider = MlsProvider::open(&bob_db);
    let (alice_cred, alice_signer) = generate_identity(b"alice", &alice_provider);
    let (bob_cred, bob_signer) = generate_identity(b"bob", &bob_provider);
    let bob_kp = generate_key_package(&bob_provider, &bob_signer, bob_cred);
    let group_config = create_config();
    let join_config = group_config.join_config().clone();
    let mut alice_group =
        MlsGroup::new(&alice_provider, &alice_signer, &group_config, alice_cred)
            .expect("create");
    let (add_bob, bob_welcome, _) = alice_group
        .add_members(&alice_provider, &alice_signer, core::slice::from_ref(&bob_kp))
        .expect("add bob");
    let _ = add_bob;
    alice_group
        .merge_pending_commit(&alice_provider)
        .expect("merge bob");
    let mut bob_group = join_from_welcome(&bob_provider, &join_config, bob_welcome);
    let bob_epoch = bob_group.epoch();

    // Alice self-updates (a commit) while Bob is "offline".
    let update = alice_group
        .self_update(&alice_provider, &alice_signer, LeafNodeParameters::default())
        .expect("alice self-update")
        .into_commit();
    alice_group
        .merge_pending_commit(&alice_provider)
        .expect("merge update");
    assert_ne!(alice_group.epoch(), bob_epoch);

    // Catch-up: Bob processes the queued commit, then decrypts.
    merge_incoming_commit(&mut bob_group, &bob_provider, update);
    assert_eq!(alice_group.epoch(), bob_group.epoch());
    let hello = alice_group
        .create_message(&alice_provider, &alice_signer, b"after catch-up")
        .expect("encrypt");
    assert_eq!(
        decrypt_application(&mut bob_group, &bob_provider, hello),
        b"after catch-up"
    );

    let _ = std::fs::remove_file(&alice_db);
    let _ = std::fs::remove_file(&bob_db);
}

#[test]
fn batch_add_200_members_one_application_message() {
    const N: usize = 200;
    let alice_db = db_path("n200-a");
    let alice_provider = MlsProvider::open(&alice_db);
    let (alice_cred, alice_signer) = generate_identity(b"alice", &alice_provider);
    let group_config = create_config();
    let join_config = group_config.join_config().clone();
    let mut alice_group =
        MlsGroup::new(&alice_provider, &alice_signer, &group_config, alice_cred)
            .expect("create");

    let mut member_dbs = Vec::with_capacity(N - 1);
    let mut packages = Vec::with_capacity(N - 1);
    let mut members = Vec::with_capacity(N - 1);
    for i in 1..N {
        let db = db_path(&format!("n200-{i}"));
        let provider = MlsProvider::open(&db);
        let identity = format!("m{i}");
        let (cred, signer) = generate_identity(identity.as_bytes(), &provider);
        let kp = generate_key_package(&provider, &signer, cred);
        packages.push(kp);
        members.push((provider, signer, identity));
        member_dbs.push(db);
    }

    let (commit, welcome, _) = alice_group
        .add_members(&alice_provider, &alice_signer, &packages)
        .expect("batch add");
    let _ = commit;
    alice_group
        .merge_pending_commit(&alice_provider)
        .expect("merge batch");
    assert_eq!(alice_group.members().count(), N);

    // Sample of joiners decrypt the same application message.
    let sample = [0usize, 7, 42, 99, 198];
    let mut sample_groups = Vec::new();
    for idx in sample {
        let (provider, _signer, _) = &members[idx];
        let group = join_from_welcome(provider, &join_config, welcome.clone());
        assert_eq!(group.members().count(), N);
        sample_groups.push(group);
    }

    let body = b"200-member workspace cue";
    let sealed = alice_group
        .create_message(&alice_provider, &alice_signer, body)
        .expect("encrypt to 200");
    for (i, group) in sample_groups.iter_mut().enumerate() {
        let (provider, _, _) = &members[sample[i]];
        assert_eq!(decrypt_application(group, provider, sealed.clone()), body);
    }

    let _ = std::fs::remove_file(&alice_db);
    for db in member_dbs {
        let _ = std::fs::remove_file(&db);
    }
}
