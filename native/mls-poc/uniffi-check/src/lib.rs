uniffi::setup_scaffolding!();

/// One trivial exported function so Phase 0 can check that UniFFI 0.32
/// emits Swift the iphonesimulator SDK can typecheck.
#[uniffi::export]
pub fn ciphersuite_name() -> String {
    "MLS_128_DHKEMX25519_AES128GCM_SHA256_Ed25519".to_string()
}
