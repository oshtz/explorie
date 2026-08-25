use crate::{
    ActiveOperation, BlockingTask, ErrorCode, ServiceContext, ServiceError, ServiceResult,
    SharedState,
};
use serde_json::Value;
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::Arc;

#[derive(Clone)]
pub struct MetadataService {
    context: ServiceContext,
    shared: Arc<SharedState>,
}

impl MetadataService {
    pub(crate) fn new(context: ServiceContext, shared: Arc<SharedState>) -> Self {
        Self { context, shared }
    }

    pub fn create_schema(
        &self,
        dir_path: PathBuf,
        fields: HashMap<String, HashMap<String, Value>>,
    ) -> BlockingTask<()> {
        let shared = Arc::clone(&self.shared);
        let guard = ActiveOperation::new(Arc::clone(&shared));
        self.context.spawn_blocking(move || {
            if remote_root(&shared, &dir_path) {
                return Err(remote_root_error());
            }
            let _guard = guard;
            explorie_core::create_explorie_schema(&dir_path, fields).map_err(ServiceError::from)
        })
    }

    pub fn create_schema_blocking(
        &self,
        dir_path: &Path,
        fields: HashMap<String, HashMap<String, Value>>,
    ) -> ServiceResult<()> {
        if remote_root(&self.shared, dir_path) {
            return Err(remote_root_error());
        }
        let _guard = ActiveOperation::new(Arc::clone(&self.shared));
        explorie_core::create_explorie_schema(dir_path, fields).map_err(ServiceError::from)
    }

    pub fn update_fields(
        &self,
        dir_path: PathBuf,
        file_name: String,
        custom_fields: HashMap<String, Value>,
    ) -> BlockingTask<()> {
        let shared = Arc::clone(&self.shared);
        let guard = ActiveOperation::new(Arc::clone(&shared));
        self.context.spawn_blocking(move || {
            if remote_root(&shared, &dir_path) {
                return Err(remote_root_error());
            }
            let _guard = guard;
            explorie_core::update_custom_fields(&dir_path, &file_name, custom_fields)
                .map_err(ServiceError::from)
        })
    }

    pub fn update_fields_blocking(
        &self,
        dir_path: &Path,
        file_name: &str,
        custom_fields: HashMap<String, Value>,
    ) -> ServiceResult<()> {
        if remote_root(&self.shared, dir_path) {
            return Err(remote_root_error());
        }
        let _guard = ActiveOperation::new(Arc::clone(&self.shared));
        explorie_core::update_custom_fields(dir_path, file_name, custom_fields)
            .map_err(ServiceError::from)
    }
}

fn remote_root(shared: &SharedState, path: &Path) -> bool {
    shared
        .remote_roots
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner)
        .contains(&crate::listing::normalize_path(path))
}

fn remote_root_error() -> ServiceError {
    ServiceError::new(
        ErrorCode::RemoteUnavailable,
        "Refusing to mutate a managed remote-drive root",
    )
}
