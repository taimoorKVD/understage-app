//! Host-side check of the UniFFI session API: Alice adds Bob via Welcome,
//! they exchange application messages, then Alice removes Bob.

use std::sync::Arc;

use understage_mls::MlsSession;

fn db_path(label: &str) -> String {
    let stamp = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap()
        .as_nanos();
    let path = std::env::temp_dir().join(format!(
        "understage-mls-session-{}-{}-{}.sqlite",
        std::process::id(),
        stamp,
        label
    ));
    let _ = std::fs::remove_file(&path);
    let _ = std::fs::remove_file(format!("{}.vault", path.display()));
    path.to_string_lossy().into_owned()
}

fn wrapping_key(seed: u8) -> Vec<u8> {
    vec![seed; 32]
}

#[test]
fn alice_bob_welcome_encrypt_decrypt_remove() {
    let alice_path = db_path("alice");
    let bob_path = db_path("bob");
    let charlie_path = db_path("charlie");
    let alice_key = wrapping_key(0xA1);
    let bob_key = wrapping_key(0xB2);
    let charlie_key = wrapping_key(0xC3);

    let alice = MlsSession::open(alice_path.clone(), alice_key.clone()).unwrap();
    let bob = MlsSession::open(bob_path.clone(), bob_key.clone()).unwrap();
    let charlie = MlsSession::open(charlie_path.clone(), charlie_key.clone()).unwrap();
    alice.generate_credential("alice".into()).unwrap();
    bob.generate_credential("bob".into()).unwrap();
    charlie.generate_credential("charlie".into()).unwrap();

    let alice_identity = alice.signature_public_key().unwrap();
    let bob_identity = bob.signature_public_key().unwrap();
    let charlie_identity = charlie.signature_public_key().unwrap();
    assert_eq!(alice_identity.len(), 32);
    assert_eq!(bob_identity.len(), 32);
    assert_ne!(alice_identity, bob_identity);
    assert_eq!(charlie_identity.len(), 32);
    assert_ne!(charlie_identity, alice_identity);
    assert_ne!(charlie_identity, bob_identity);

    let bob_kp = bob.export_key_package().unwrap();
    let _group_id = alice.create_group().unwrap();
    let added = alice.add_member(bob_kp).unwrap();
    let bob_epoch = bob.join_from_welcome(added.welcome).unwrap();
    assert_eq!(bob_epoch, alice.epoch().unwrap());
    assert_eq!(bob_epoch, added.epoch);

    let charlie_added = alice.add_member(charlie.export_key_package().unwrap()).unwrap();
    let bob_charlie = bob.process_incoming(charlie_added.commit).unwrap();
    assert_eq!(bob_charlie.epoch, alice.epoch().unwrap());
    assert_eq!(charlie.join_from_welcome(charlie_added.welcome).unwrap(), alice.epoch().unwrap());

    let hello = alice.encrypt(b"hello from alice".to_vec()).unwrap();
    assert_eq!(bob.decrypt(hello).unwrap(), b"hello from alice");

    let reply = bob.encrypt(b"hello from bob".to_vec()).unwrap();
    assert_eq!(alice.decrypt(reply).unwrap(), b"hello from bob");

    // Reload from sqlite + wrapped vault with the same wrapping keys.
    drop(alice);
    drop(bob);
    drop(charlie);
    let alice = MlsSession::open(alice_path.clone(), alice_key).unwrap();
    let bob = MlsSession::open(bob_path.clone(), bob_key).unwrap();
    let charlie = MlsSession::open(charlie_path.clone(), charlie_key).unwrap();
    assert_eq!(alice.signature_public_key().unwrap(), alice_identity);
    assert_eq!(bob.signature_public_key().unwrap(), bob_identity);
    assert_eq!(charlie.signature_public_key().unwrap(), charlie_identity);
    let after = alice.encrypt(b"after reload".to_vec()).unwrap();
    assert_eq!(bob.decrypt(after.clone()).unwrap(), b"after reload");
    assert_eq!(charlie.decrypt(after).unwrap(), b"after reload");

    let removed = alice.remove_member("bob".into()).unwrap();
    let processed = bob.process_incoming(removed.commit.clone()).unwrap();
    assert_eq!(processed.kind, "commit");
    let remaining = charlie.process_incoming(removed.commit.clone()).unwrap();
    assert_eq!(remaining.kind, "commit");
    assert_eq!(remaining.epoch, alice.epoch().unwrap());

    let gone = alice.encrypt(b"bob is gone".to_vec()).unwrap();
    assert_eq!(charlie.decrypt(gone.clone()).unwrap(), b"bob is gone");
    assert!(
        bob.decrypt(gone).is_err(),
        "removed member must not decrypt a new message"
    );
    assert!(bob.encrypt(b"must fail".to_vec()).is_err());

    let _ = std::fs::remove_file(&alice_path);
    let _ = std::fs::remove_file(&bob_path);
    let _ = std::fs::remove_file(&charlie_path);
    let _ = std::fs::remove_file(format!("{alice_path}.vault"));
    let _ = std::fs::remove_file(format!("{bob_path}.vault"));
    let _ = std::fs::remove_file(format!("{charlie_path}.vault"));
    let _ = Arc::strong_count(&alice);
}
