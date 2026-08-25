//! Compatibility re-export for code that still refers to the old Tauri module.
//!
//! The implementation lives in `explorie-native-services`; this module is
//! intentionally free of Tauri imports and will disappear with the adapter.
pub use explorie_native_services::remote_drives::*;
