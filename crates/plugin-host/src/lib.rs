//! Plugin host for explorie with support for static and dynamic plugins.
//!
//! # Overview
//!
//! This crate provides a plugin system that supports:
//! - **Static plugins**: Compiled into the application, registered at startup
//! - **Dynamic plugins**: Loaded at runtime from shared libraries (.dll/.so/.dylib)
//! - **WASM plugins**: (Optional) Sandboxed plugins via WebAssembly (requires `wasm` feature)
//!
//! # Dynamic Plugin Loading
//!
//! Dynamic plugins are shared libraries that export specific symbols:
//!
//! ```c
//! // Required exports for a dynamic plugin
//! const char* plugin_name();
//! const char* plugin_methods();  // Comma-separated method names
//! char* plugin_invoke(const char* method, const char* payload_json);
//! void plugin_free_string(char* s);
//! ```
//!
//! # Example
//!
//! ```rust,ignore
//! use explorie_plugin_host::{PluginHost, PluginApi};
//!
//! let host = PluginHost::new();
//!
//! // Register a static plugin
//! host.register(MyPlugin::new()).unwrap();
//!
//! // Load a dynamic plugin
//! host.load_plugin("/path/to/plugin.so").unwrap();
//!
//! // Call a plugin method
//! let result = host.call("my-plugin", "greet", Some(json!({"name": "World"}))).unwrap();
//! ```

use libloading::{Library, Symbol};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::HashMap;
use std::ffi::{CStr, CString};
use std::fmt;
use std::os::raw::c_char;
use std::path::Path;
use std::sync::{Arc, RwLock};

/// Errors that can occur while resolving or invoking plugins.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum PluginError {
    /// The requested plugin does not exist.
    NotFound(String),
    /// The plugin does not expose the requested method.
    MethodNotFound { plugin: String, method: String },
    /// The plugin returned an error.
    Invocation {
        plugin: String,
        method: String,
        message: String,
    },
}

impl fmt::Display for PluginError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            PluginError::NotFound(name) => write!(f, "plugin '{name}' not found"),
            PluginError::MethodNotFound { plugin, method } => {
                write!(f, "plugin '{plugin}' does not expose method '{method}'")
            }
            PluginError::Invocation {
                plugin,
                method,
                message,
            } => write!(
                f,
                "plugin '{plugin}' invocation failed for '{method}': {message}"
            ),
        }
    }
}

impl std::error::Error for PluginError {}

// =============================================================================
// Plugin API - Functionality exposed to plugins
// =============================================================================

/// Request types that plugins can make to the host.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "type", content = "data")]
pub enum PluginRequest {
    /// Read a file's contents.
    ReadFile { path: String },
    /// Write content to a file.
    WriteFile { path: String, content: String },
    /// Check if a path exists.
    PathExists { path: String },
    /// List directory contents.
    ListDir { path: String },
    /// Get file metadata.
    FileMetadata { path: String },
    /// Show a notification to the user.
    Notify {
        title: String,
        body: String,
        #[serde(default)]
        level: NotificationLevel,
    },
    /// Log a message.
    Log {
        message: String,
        #[serde(default)]
        level: LogLevel,
    },
    /// Get environment variable.
    GetEnv { name: String },
    /// Get current working directory.
    GetCwd,
}

/// Response types from plugin API calls.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "type", content = "data")]
pub enum PluginResponse {
    /// Success with optional data.
    Ok(Option<Value>),
    /// String content (e.g., file contents).
    Content(String),
    /// Boolean result.
    Bool(bool),
    /// File metadata.
    Metadata {
        size: u64,
        is_dir: bool,
        is_file: bool,
        modified: Option<u64>,
    },
    /// Directory listing.
    DirEntries(Vec<DirEntry>),
    /// Error occurred.
    Error { code: String, message: String },
}

/// A directory entry returned by ListDir.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DirEntry {
    pub name: String,
    pub path: String,
    pub is_dir: bool,
    pub is_file: bool,
    pub size: Option<u64>,
}

/// Notification severity level.
#[derive(Debug, Clone, Copy, Default, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum NotificationLevel {
    #[default]
    Info,
    Warning,
    Error,
    Success,
}

/// Log level for plugin logging.
#[derive(Debug, Clone, Copy, Default, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum LogLevel {
    Trace,
    Debug,
    #[default]
    Info,
    Warn,
    Error,
}

/// Plugin API handler that processes requests from plugins.
///
/// Implement this trait to provide filesystem, notification, and other APIs to plugins.
pub trait PluginApiHandler: Send + Sync {
    /// Handle a request from a plugin.
    fn handle(&self, request: PluginRequest) -> PluginResponse;
}

/// Default no-op API handler (returns errors for all requests).
#[derive(Debug, Default)]
pub struct NoOpApiHandler;

impl PluginApiHandler for NoOpApiHandler {
    fn handle(&self, request: PluginRequest) -> PluginResponse {
        PluginResponse::Error {
            code: "not_implemented".into(),
            message: format!("API not available: {:?}", request),
        }
    }
}

/// Standard filesystem API handler.
///
/// Provides basic filesystem operations to plugins.
#[derive(Debug, Default)]
pub struct StandardApiHandler {
    /// Base directory for sandboxed file operations (if any).
    pub sandbox_root: Option<std::path::PathBuf>,
}

impl StandardApiHandler {
    /// Create a new handler with no sandbox restrictions.
    pub fn new() -> Self {
        Self { sandbox_root: None }
    }

    /// Create a handler that restricts file operations to a directory.
    pub fn sandboxed(root: impl Into<std::path::PathBuf>) -> Self {
        Self {
            sandbox_root: Some(root.into()),
        }
    }

    /// Check if a path is allowed (within sandbox if configured).
    fn is_path_allowed(&self, path: &Path) -> bool {
        match &self.sandbox_root {
            Some(root) => {
                let Ok(canonical) = path.canonicalize() else {
                    return false;
                };
                let Ok(root_canonical) = root.canonicalize() else {
                    return false;
                };
                canonical.starts_with(root_canonical)
            }
            None => true,
        }
    }
}

impl PluginApiHandler for StandardApiHandler {
    fn handle(&self, request: PluginRequest) -> PluginResponse {
        match request {
            PluginRequest::ReadFile { path } => {
                let path = Path::new(&path);
                if !self.is_path_allowed(path) {
                    return PluginResponse::Error {
                        code: "access_denied".into(),
                        message: "Path is outside sandbox".into(),
                    };
                }
                match std::fs::read_to_string(path) {
                    Ok(content) => PluginResponse::Content(content),
                    Err(e) => PluginResponse::Error {
                        code: "io_error".into(),
                        message: e.to_string(),
                    },
                }
            }
            PluginRequest::WriteFile { path, content } => {
                let path = Path::new(&path);
                if !self.is_path_allowed(path) {
                    return PluginResponse::Error {
                        code: "access_denied".into(),
                        message: "Path is outside sandbox".into(),
                    };
                }
                match std::fs::write(path, content) {
                    Ok(()) => PluginResponse::Ok(None),
                    Err(e) => PluginResponse::Error {
                        code: "io_error".into(),
                        message: e.to_string(),
                    },
                }
            }
            PluginRequest::PathExists { path } => {
                let path = Path::new(&path);
                PluginResponse::Bool(path.exists() && self.is_path_allowed(path))
            }
            PluginRequest::ListDir { path } => {
                let path = Path::new(&path);
                if !self.is_path_allowed(path) {
                    return PluginResponse::Error {
                        code: "access_denied".into(),
                        message: "Path is outside sandbox".into(),
                    };
                }
                match std::fs::read_dir(path) {
                    Ok(entries) => {
                        let mut results = Vec::new();
                        for entry in entries.flatten() {
                            let meta = entry.metadata().ok();
                            results.push(DirEntry {
                                name: entry.file_name().to_string_lossy().into(),
                                path: entry.path().to_string_lossy().into(),
                                is_dir: meta.as_ref().map(|m| m.is_dir()).unwrap_or(false),
                                is_file: meta.as_ref().map(|m| m.is_file()).unwrap_or(false),
                                size: meta.as_ref().map(|m| m.len()),
                            });
                        }
                        PluginResponse::DirEntries(results)
                    }
                    Err(e) => PluginResponse::Error {
                        code: "io_error".into(),
                        message: e.to_string(),
                    },
                }
            }
            PluginRequest::FileMetadata { path } => {
                let path = Path::new(&path);
                if !self.is_path_allowed(path) {
                    return PluginResponse::Error {
                        code: "access_denied".into(),
                        message: "Path is outside sandbox".into(),
                    };
                }
                match std::fs::metadata(path) {
                    Ok(meta) => PluginResponse::Metadata {
                        size: meta.len(),
                        is_dir: meta.is_dir(),
                        is_file: meta.is_file(),
                        modified: meta
                            .modified()
                            .ok()
                            .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
                            .map(|d| d.as_secs()),
                    },
                    Err(e) => PluginResponse::Error {
                        code: "io_error".into(),
                        message: e.to_string(),
                    },
                }
            }
            PluginRequest::Notify { title, body, level } => {
                // Default implementation just logs; real impl would show OS notification
                eprintln!("[{:?}] {}: {}", level, title, body);
                PluginResponse::Ok(None)
            }
            PluginRequest::Log { message, level } => {
                eprintln!("[Plugin {:?}] {}", level, message);
                PluginResponse::Ok(None)
            }
            PluginRequest::GetEnv { name } => match std::env::var(&name) {
                Ok(val) => PluginResponse::Content(val),
                Err(_) => PluginResponse::Ok(None),
            },
            PluginRequest::GetCwd => match std::env::current_dir() {
                Ok(path) => PluginResponse::Content(path.to_string_lossy().into()),
                Err(e) => PluginResponse::Error {
                    code: "io_error".into(),
                    message: e.to_string(),
                },
            },
        }
    }
}

// =============================================================================
// Dynamic Plugin Loading (dlopen)
// =============================================================================

/// Type signatures for dynamic plugin exports.
type PluginNameFn = unsafe extern "C" fn() -> *const c_char;
type PluginMethodsFn = unsafe extern "C" fn() -> *const c_char;
type PluginInvokeFn = unsafe extern "C" fn(*const c_char, *const c_char) -> *mut c_char;
type PluginFreeStringFn = unsafe extern "C" fn(*mut c_char);

/// A plugin loaded from a shared library at runtime.
pub struct DynamicPlugin {
    _library: Library,
    name: String,
    methods: Vec<&'static str>,
    invoke_fn: PluginInvokeFn,
    free_fn: PluginFreeStringFn,
}

// SAFETY: The plugin functions are called from a single thread at a time via RwLock
unsafe impl Send for DynamicPlugin {}
unsafe impl Sync for DynamicPlugin {}

impl DynamicPlugin {
    /// Load a plugin from a shared library path.
    ///
    /// # Safety
    ///
    /// The library must export the required plugin symbols with correct signatures.
    /// Loading untrusted libraries is inherently unsafe.
    ///
    /// # Errors
    ///
    /// Returns an error if:
    /// - The library cannot be loaded
    /// - Required symbols are missing
    /// - Symbol data is invalid
    pub unsafe fn load(path: impl AsRef<Path>) -> Result<Self, PluginError> {
        let path = path.as_ref();

        // SAFETY: Loading shared libraries requires trusting the library code
        let library = unsafe {
            Library::new(path).map_err(|e| PluginError::Invocation {
                plugin: path.display().to_string(),
                method: "<load>".into(),
                message: format!("failed to load library: {}", e),
            })?
        };

        // SAFETY: Getting symbols from loaded library
        let name_fn: Symbol<PluginNameFn> = unsafe {
            library
                .get(b"plugin_name\0")
                .map_err(|e| PluginError::Invocation {
                    plugin: path.display().to_string(),
                    method: "<load>".into(),
                    message: format!("missing plugin_name symbol: {}", e),
                })?
        };

        let methods_fn: Symbol<PluginMethodsFn> = unsafe {
            library
                .get(b"plugin_methods\0")
                .map_err(|e| PluginError::Invocation {
                    plugin: path.display().to_string(),
                    method: "<load>".into(),
                    message: format!("missing plugin_methods symbol: {}", e),
                })?
        };

        let invoke_fn: Symbol<PluginInvokeFn> = unsafe {
            library
                .get(b"plugin_invoke\0")
                .map_err(|e| PluginError::Invocation {
                    plugin: path.display().to_string(),
                    method: "<load>".into(),
                    message: format!("missing plugin_invoke symbol: {}", e),
                })?
        };

        let free_fn: Symbol<PluginFreeStringFn> = unsafe {
            library
                .get(b"plugin_free_string\0")
                .map_err(|e| PluginError::Invocation {
                    plugin: path.display().to_string(),
                    method: "<load>".into(),
                    message: format!("missing plugin_free_string symbol: {}", e),
                })?
        };

        // SAFETY: Calling plugin function that returns a static string
        let name_ptr = unsafe { name_fn() };
        if name_ptr.is_null() {
            return Err(PluginError::Invocation {
                plugin: path.display().to_string(),
                method: "<load>".into(),
                message: "plugin_name returned null".into(),
            });
        }

        // SAFETY: Plugin guarantees this is a valid null-terminated string
        let name = unsafe {
            CStr::from_ptr(name_ptr)
                .to_str()
                .map_err(|e| PluginError::Invocation {
                    plugin: path.display().to_string(),
                    method: "<load>".into(),
                    message: format!("invalid plugin name: {}", e),
                })?
                .to_string()
        };

        // SAFETY: Calling plugin function that returns a static string
        let methods_ptr = unsafe { methods_fn() };
        let methods: Vec<&'static str> = if methods_ptr.is_null() {
            Vec::new()
        } else {
            // SAFETY: Plugin guarantees this is a valid null-terminated string
            let methods_str = unsafe {
                CStr::from_ptr(methods_ptr)
                    .to_str()
                    .map_err(|e| PluginError::Invocation {
                        plugin: name.clone(),
                        method: "<load>".into(),
                        message: format!("invalid methods string: {}", e),
                    })?
            };
            // Leak the string so we can return static references
            let leaked: &'static str = Box::leak(methods_str.to_string().into_boxed_str());
            leaked
                .split(',')
                .map(|s| s.trim())
                .filter(|s| !s.is_empty())
                .collect()
        };

        // Copy function pointers before library moves
        let invoke_fn = *invoke_fn;
        let free_fn = *free_fn;

        Ok(Self {
            _library: library,
            name,
            methods,
            invoke_fn,
            free_fn,
        })
    }
}

impl Plugin for DynamicPlugin {
    fn name(&self) -> &str {
        &self.name
    }

    fn methods(&self) -> &[&'static str] {
        &self.methods
    }

    fn invoke(&self, method: &str, payload: Option<Value>) -> Result<Value, PluginError> {
        let method_cstr = CString::new(method).map_err(|e| PluginError::Invocation {
            plugin: self.name.clone(),
            method: method.into(),
            message: format!("invalid method name: {}", e),
        })?;

        let payload_str = match payload {
            Some(v) => serde_json::to_string(&v).map_err(|e| PluginError::Invocation {
                plugin: self.name.clone(),
                method: method.into(),
                message: format!("failed to serialize payload: {}", e),
            })?,
            None => "null".to_string(),
        };
        let payload_cstr = CString::new(payload_str).map_err(|e| PluginError::Invocation {
            plugin: self.name.clone(),
            method: method.into(),
            message: format!("invalid payload: {}", e),
        })?;

        // SAFETY: We're calling the plugin's invoke function with valid C strings
        let result_ptr = unsafe { (self.invoke_fn)(method_cstr.as_ptr(), payload_cstr.as_ptr()) };

        if result_ptr.is_null() {
            return Err(PluginError::Invocation {
                plugin: self.name.clone(),
                method: method.into(),
                message: "plugin_invoke returned null".into(),
            });
        }

        // SAFETY: Plugin returned a valid string pointer
        let result_cstr = unsafe { CStr::from_ptr(result_ptr) };
        let result_str = result_cstr.to_str().map_err(|e| {
            // Free the string before returning error
            unsafe { (self.free_fn)(result_ptr) };
            PluginError::Invocation {
                plugin: self.name.clone(),
                method: method.into(),
                message: format!("invalid result string: {}", e),
            }
        })?;

        let result: Value = serde_json::from_str(result_str).map_err(|e| {
            // Free the string before returning error
            unsafe { (self.free_fn)(result_ptr) };
            PluginError::Invocation {
                plugin: self.name.clone(),
                method: method.into(),
                message: format!("invalid result JSON: {}", e),
            }
        })?;

        // Free the result string
        unsafe { (self.free_fn)(result_ptr) };

        // Check for error response
        if let Some(error) = result.get("error") {
            return Err(PluginError::Invocation {
                plugin: self.name.clone(),
                method: method.into(),
                message: error.as_str().unwrap_or("unknown error").into(),
            });
        }

        Ok(result)
    }
}

// =============================================================================
// Plugin Trait
// =============================================================================

/// Trait implemented by plugins that can be registered with the host.
pub trait Plugin: Send + Sync {
    /// Unique, human-friendly name for the plugin.
    fn name(&self) -> &str;

    /// Invoke a plugin method with an optional JSON payload.
    ///
    /// Returning a [`PluginError::Invocation`] lets the host bubble rich errors to callers.
    fn invoke(&self, method: &str, payload: Option<Value>) -> Result<Value, PluginError>;

    /// List of methods this plugin supports. Optional, but helpful for introspection/UI.
    fn methods(&self) -> &[&'static str] {
        &[]
    }
}

/// In-memory registry and dispatcher for plugins.
#[derive(Default, Clone)]
pub struct PluginHost {
    plugins: Arc<RwLock<HashMap<String, Arc<dyn Plugin>>>>,
}

impl PluginHost {
    /// Create an empty host.
    pub fn new() -> Self {
        Self {
            plugins: Arc::new(RwLock::new(HashMap::new())),
        }
    }

    /// Register a plugin. Fails if a plugin with the same name already exists.
    pub fn register<P: Plugin + 'static>(&self, plugin: P) -> Result<(), PluginError> {
        let name = plugin.name().to_string();
        let mut guard = self.plugins.write().expect("plugin registry lock poisoned");
        if guard.contains_key(&name) {
            return Err(PluginError::Invocation {
                plugin: name,
                method: "<register>".into(),
                message: "duplicate plugin name".into(),
            });
        }
        guard.insert(name, Arc::new(plugin));
        Ok(())
    }

    /// Return all registered plugin names.
    pub fn list(&self) -> Vec<String> {
        let guard = self.plugins.read().expect("plugin registry lock poisoned");
        guard.keys().cloned().collect()
    }

    /// Return the methods exposed by a specific plugin.
    pub fn methods(&self, plugin: &str) -> Result<Vec<String>, PluginError> {
        let guard = self.plugins.read().expect("plugin registry lock poisoned");
        let target = guard
            .get(plugin)
            .ok_or_else(|| PluginError::NotFound(plugin.to_string()))?;
        Ok(target.methods().iter().map(|s| s.to_string()).collect())
    }

    /// Invoke a method on the given plugin.
    pub fn call(
        &self,
        plugin: &str,
        method: &str,
        payload: Option<Value>,
    ) -> Result<Value, PluginError> {
        let guard = self.plugins.read().expect("plugin registry lock poisoned");
        let target = guard
            .get(plugin)
            .cloned()
            .ok_or_else(|| PluginError::NotFound(plugin.to_string()))?;
        if let Some(known) = target.methods().iter().find(|m| **m == method)
            && known.is_empty()
        {
            return Err(PluginError::MethodNotFound {
                plugin: plugin.to_string(),
                method: method.to_string(),
            });
        }
        target.invoke(method, payload)
    }

    /// Load a plugin from a shared library (.dll/.so/.dylib).
    ///
    /// # Safety
    ///
    /// Loading shared libraries is inherently unsafe. Only load plugins from
    /// trusted sources. The library must export the required plugin symbols:
    ///
    /// - `plugin_name() -> *const c_char`
    /// - `plugin_methods() -> *const c_char` (comma-separated)
    /// - `plugin_invoke(method: *const c_char, payload: *const c_char) -> *mut c_char`
    /// - `plugin_free_string(s: *mut c_char)`
    ///
    /// # Errors
    ///
    /// Returns an error if:
    /// - The library cannot be loaded
    /// - Required symbols are missing
    /// - A plugin with the same name is already registered
    ///
    /// # Example
    ///
    /// ```rust,ignore
    /// let host = PluginHost::new();
    /// unsafe {
    ///     host.load_plugin("/path/to/my_plugin.so")?;
    /// }
    /// host.call("my-plugin", "greet", Some(json!({"name": "World"})))?;
    /// ```
    pub unsafe fn load_plugin(&self, path: impl AsRef<Path>) -> Result<String, PluginError> {
        // SAFETY: Caller guarantees the library is safe to load
        let plugin = unsafe { DynamicPlugin::load(path)? };
        let name = plugin.name().to_string();
        self.register(plugin)?;
        Ok(name)
    }

    /// Unload a plugin by name.
    ///
    /// This removes the plugin from the registry. For dynamic plugins, the
    /// shared library will be unloaded when the last reference is dropped.
    ///
    /// # Errors
    ///
    /// Returns an error if the plugin doesn't exist.
    pub fn unload_plugin(&self, name: &str) -> Result<(), PluginError> {
        let mut guard = self.plugins.write().expect("plugin registry lock poisoned");
        if guard.remove(name).is_none() {
            return Err(PluginError::NotFound(name.to_string()));
        }
        Ok(())
    }

    /// Check if a plugin is registered.
    pub fn has_plugin(&self, name: &str) -> bool {
        let guard = self.plugins.read().expect("plugin registry lock poisoned");
        guard.contains_key(name)
    }

    /// Get the number of registered plugins.
    pub fn plugin_count(&self) -> usize {
        let guard = self.plugins.read().expect("plugin registry lock poisoned");
        guard.len()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    use std::sync::atomic::{AtomicUsize, Ordering};
    use std::thread;

    struct EchoPlugin;
    impl Plugin for EchoPlugin {
        fn name(&self) -> &str {
            "echo"
        }

        fn invoke(&self, method: &str, payload: Option<Value>) -> Result<Value, PluginError> {
            match method {
                "ping" => Ok(json!({"pong": true})),
                "payload" => Ok(json!({ "payload": payload })),
                other => Err(PluginError::MethodNotFound {
                    plugin: self.name().into(),
                    method: other.into(),
                }),
            }
        }

        fn methods(&self) -> &[&'static str] {
            &["ping", "payload"]
        }
    }

    struct CountingPlugin {
        count: Arc<AtomicUsize>,
    }

    impl Plugin for CountingPlugin {
        fn name(&self) -> &str {
            "counting"
        }

        fn invoke(&self, method: &str, _payload: Option<Value>) -> Result<Value, PluginError> {
            if method != "ping" {
                return Err(PluginError::MethodNotFound {
                    plugin: self.name().into(),
                    method: method.into(),
                });
            }
            self.count.fetch_add(1, Ordering::SeqCst);
            Ok(json!({"ok": true}))
        }

        fn methods(&self) -> &[&'static str] {
            &["ping"]
        }
    }

    struct ConfigPlugin;

    impl Plugin for ConfigPlugin {
        fn name(&self) -> &str {
            "config"
        }

        fn invoke(&self, method: &str, payload: Option<Value>) -> Result<Value, PluginError> {
            if method != "set" {
                return Err(PluginError::MethodNotFound {
                    plugin: self.name().into(),
                    method: method.into(),
                });
            }
            let enabled = payload
                .and_then(|value| value.get("enabled").cloned())
                .and_then(|value| value.as_bool())
                .ok_or_else(|| PluginError::Invocation {
                    plugin: self.name().into(),
                    method: method.into(),
                    message: "missing or invalid 'enabled' field".into(),
                })?;
            Ok(json!({"enabled": enabled}))
        }

        fn methods(&self) -> &[&'static str] {
            &["set"]
        }
    }

    #[test]
    fn registers_and_invokes_plugins() {
        let host = PluginHost::new();
        host.register(EchoPlugin).expect("register plugin");
        let list = host.list();
        assert_eq!(list, vec!["echo".to_string()]);

        let val = host
            .call("echo", "ping", None)
            .expect("plugin should respond");
        assert_eq!(val["pong"], json!(true));

        let payload = json!({"msg": "hello"});
        let echoed = host
            .call("echo", "payload", Some(payload.clone()))
            .expect("payload should echo");
        assert_eq!(echoed["payload"], payload);
    }

    #[test]
    fn fails_on_missing_plugin_or_method() {
        let host = PluginHost::new();
        let err = host.call("missing", "ping", None).unwrap_err();
        assert!(matches!(err, PluginError::NotFound(_)));

        host.register(EchoPlugin).unwrap();
        let err = host.call("echo", "unknown", None).unwrap_err();
        assert!(matches!(err, PluginError::MethodNotFound { .. }));
    }

    #[test]
    fn rejects_duplicate_registration() {
        let host = PluginHost::new();
        host.register(EchoPlugin).unwrap();
        let err = host.register(EchoPlugin).unwrap_err();
        assert!(matches!(err, PluginError::Invocation { .. }));
    }

    #[test]
    fn rejects_invalid_payloads() {
        let host = PluginHost::new();
        host.register(ConfigPlugin).unwrap();
        let err = host.call("config", "set", None).unwrap_err();
        assert!(matches!(err, PluginError::Invocation { .. }));
    }

    #[test]
    fn handles_concurrent_calls() {
        let host = PluginHost::new();
        let counter = Arc::new(AtomicUsize::new(0));
        host.register(CountingPlugin {
            count: Arc::clone(&counter),
        })
        .unwrap();

        let host = Arc::new(host);
        let mut handles = Vec::new();
        for _ in 0..8 {
            let host = Arc::clone(&host);
            handles.push(thread::spawn(move || {
                for _ in 0..25 {
                    host.call("counting", "ping", None).unwrap();
                }
            }));
        }

        for handle in handles {
            handle.join().unwrap();
        }

        assert_eq!(counter.load(Ordering::SeqCst), 200);
    }
}
