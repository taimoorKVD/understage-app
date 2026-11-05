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
    let alice_key = wrapping_key(0xA1);
    let bob_key = wrapping_key(0xB2);

    let alice = MlsSession::open(alice_path.clone(), alice_key.clone()).unwrap();
    let bob = MlsSession::open(bob_path.clone(), bob_key.clone()).unwrap();
    alice.generate_credential("alice".into()).unwrap();
    bob.generate_credential("bob".into()).unwrap();

    let bob_kp = bob.export_key_package().unwrap();
    let _group_id = alice.create_group().unwrap();
    let added = alice.add_member(bob_kp).unwrap();
    let bob_epoch = bob.join_from_welcome(added.welcome).unwrap();
    assert_eq!(bob_epoch, alice.epoch().unwrap());
    assert_eq!(bob_epoch, added.epoch);

    let hello = alice.encrypt(b"hello from alice".to_vec()).unwrap();
    assert_eq!(bob.decrypt(hello).unwrap(), b"hello from alice");

    let reply = bob.encrypt(b"hello from bob".to_vec()).unwrap();
    assert_eq!(alice.decrypt(reply).unwrap(), b"hello from bob");

    // Reload from sqlite + wrapped vault with the same wrapping keys.
    drop(alice);
    drop(bob);
    let alice = MlsSession::open(alice_path.clone(), alice_key).unwrap();
    let bob = MlsSession::open(bob_path.clone(), bob_key).unwrap();
    let after = alice.encrypt(b"after reload".to_vec()).unwrap();
    assert_eq!(bob.decrypt(after).unwrap(), b"after reload");

    let removed = alice.remove_member("bob".into()).unwrap();
    let processed = bob.process_incoming(removed.commit).unwrap();
    assert_eq!(processed.kind, "commit");

    let gone = alice.encrypt(b"bob is gone".to_vec()).unwrap();
    assert!(
        bob.decrypt(gone).is_err(),
        "removed member must not decrypt a new message"
    );

    let _ = std::fs::remove_file(&alice_path);
    let _ = std::fs::remove_file(&bob_path);
    let _ = std::fs::remove_file(format!("{alice_path}.vault"));
    let _ = std::fs::remove_file(format!("{bob_path}.vault"));
    let _ = Arc::strong_count(&alice);
}
