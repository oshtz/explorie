use crate::{ErrorCode, ServiceError, ServiceResult};
use asset_importer::{Importer, postprocess::PostProcessSteps};
use std::fs;
use std::path::Component;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::SystemTime;

const MAX_MODEL_BYTES: u64 = 512 * 1024 * 1024;
const MAX_MODEL_VERTICES: usize = 2_000_000;
const MAX_MODEL_TRIANGLES: usize = 2_000_000;
const MAX_RENDER_TRIANGLES: usize = 300_000;
const MAX_FRAME_DIMENSION: u32 = 1_280;
const MAX_REFERENCE_MANIFEST_BYTES: u64 = 16 * 1024 * 1024;

#[derive(Clone, Copy, Debug, PartialEq)]
pub struct ModelCamera {
    pub yaw: f32,
    pub pitch: f32,
    pub zoom: f32,
    pub pan_x: f32,
    pub pan_y: f32,
}

impl Default for ModelCamera {
    fn default() -> Self {
        Self {
            yaw: 0.65,
            pitch: -0.35,
            zoom: 1.0,
            pan_x: 0.0,
            pan_y: 0.0,
        }
    }
}

#[derive(Clone, Debug)]
pub struct ModelFrame {
    pub width: u32,
    pub height: u32,
    pub rgba: Arc<[u8]>,
}

#[derive(Clone, Debug)]
pub struct ModelPreview {
    pub frame: ModelFrame,
    pub format: String,
    pub mesh_count: usize,
    pub vertex_count: usize,
    pub triangle_count: usize,
    pub sampled: bool,
}

#[derive(Clone, Debug)]
struct Triangle {
    indices: [u32; 3],
    color: [u8; 3],
}

#[derive(Clone, Debug)]
struct ModelGeometry {
    format: String,
    mesh_count: usize,
    vertex_count: usize,
    triangle_count: usize,
    vertices: Vec<[f32; 3]>,
    triangles: Vec<Triangle>,
}

#[derive(Clone, Debug, Eq, PartialEq)]
struct SourceIdentity {
    path: PathBuf,
    len: u64,
    modified: Option<SystemTime>,
}

#[derive(Clone)]
struct CachedGeometry {
    identity: SourceIdentity,
    geometry: Arc<ModelGeometry>,
}

#[derive(Clone, Default)]
pub struct ModelPreviewCache {
    inner: Arc<Mutex<Option<CachedGeometry>>>,
}

impl ModelPreviewCache {
    pub fn render(
        &self,
        path: &Path,
        camera: ModelCamera,
        width: u32,
        height: u32,
    ) -> ServiceResult<ModelPreview> {
        let identity = source_identity(path)?;
        let geometry = {
            let mut cache = self
                .inner
                .lock()
                .unwrap_or_else(std::sync::PoisonError::into_inner);
            if let Some(cached) = cache.as_ref()
                && cached.identity == identity
            {
                Arc::clone(&cached.geometry)
            } else {
                let geometry = Arc::new(load_geometry(path)?);
                *cache = Some(CachedGeometry {
                    identity,
                    geometry: Arc::clone(&geometry),
                });
                geometry
            }
        };
        let frame = rasterize(&geometry, camera, width, height)?;
        Ok(ModelPreview {
            frame,
            format: geometry.format.clone(),
            mesh_count: geometry.mesh_count,
            vertex_count: geometry.vertex_count,
            triangle_count: geometry.triangle_count,
            sampled: geometry.triangle_count > geometry.triangles.len(),
        })
    }
}

fn source_identity(path: &Path) -> ServiceResult<SourceIdentity> {
    let metadata = fs::metadata(path).map_err(ServiceError::from)?;
    if !metadata.is_file() {
        return Err(ServiceError::new(
            ErrorCode::InvalidInput,
            "3D preview requires a regular file",
        ));
    }
    if metadata.len() > MAX_MODEL_BYTES {
        return Err(ServiceError::new(
            ErrorCode::Unsupported,
            "3D preview is limited to files no larger than 512 MiB",
        ));
    }
    Ok(SourceIdentity {
        path: path.to_path_buf(),
        len: metadata.len(),
        modified: metadata.modified().ok(),
    })
}

fn load_geometry(path: &Path) -> ServiceResult<ModelGeometry> {
    validate_local_references(path)?;
    let steps = PostProcessSteps::TRIANGULATE
        | PostProcessSteps::JOIN_IDENTICAL_VERTICES
        | PostProcessSteps::PRE_TRANSFORM_VERTICES
        | PostProcessSteps::GEN_SMOOTH_NORMALS
        | PostProcessSteps::SORT_BY_PTYPE
        | PostProcessSteps::FIND_DEGENERATES
        | PostProcessSteps::FIND_INVALID_DATA;
    let scene = Importer::new()
        .read_file(path)
        .with_post_process(steps)
        .import()
        .map_err(|error| {
            ServiceError::new(
                ErrorCode::InvalidInput,
                format!("Unable to parse 3D model: {error}"),
            )
        })?;
    let mesh_count = scene.num_meshes();
    if mesh_count == 0 {
        return Err(ServiceError::new(
            ErrorCode::InvalidInput,
            "The 3D model does not contain a renderable mesh",
        ));
    }

    let mut vertices = Vec::new();
    let mut all_triangles = Vec::new();
    for (mesh_index, mesh) in scene.meshes().enumerate() {
        if vertices.len().saturating_add(mesh.num_vertices()) > MAX_MODEL_VERTICES {
            return Err(ServiceError::new(
                ErrorCode::Unsupported,
                "The 3D model contains too many vertices to preview safely",
            ));
        }
        let base = u32::try_from(vertices.len()).map_err(|_| {
            ServiceError::new(ErrorCode::Unsupported, "The 3D model is too large to index")
        })?;
        vertices.extend(
            mesh.vertices_iter()
                .map(|vertex| [vertex.x, vertex.y, vertex.z]),
        );

        let color = scene
            .material(mesh.material_index())
            .and_then(|material| material.base_color())
            .map(|color| {
                [
                    unit_to_byte(color.x),
                    unit_to_byte(color.y),
                    unit_to_byte(color.z),
                ]
            })
            .or_else(|| {
                scene
                    .material(mesh.material_index())
                    .and_then(|material| material.diffuse_color())
                    .map(|color| {
                        [
                            unit_to_byte(color.x),
                            unit_to_byte(color.y),
                            unit_to_byte(color.z),
                        ]
                    })
            })
            .unwrap_or_else(|| mesh_color(mesh_index));

        for face in mesh.faces_iter() {
            let indices = face.indices();
            if indices.len() != 3 {
                continue;
            }
            if all_triangles.len() >= MAX_MODEL_TRIANGLES {
                return Err(ServiceError::new(
                    ErrorCode::Unsupported,
                    "The 3D model contains too many triangles to preview safely",
                ));
            }
            all_triangles.push(Triangle {
                indices: [base + indices[0], base + indices[1], base + indices[2]],
                color,
            });
        }
    }
    if vertices.is_empty() || all_triangles.is_empty() {
        return Err(ServiceError::new(
            ErrorCode::InvalidInput,
            "The 3D model does not contain triangle geometry",
        ));
    }

    normalize_vertices(&mut vertices)?;
    let triangle_count = all_triangles.len();
    let triangles = if triangle_count > MAX_RENDER_TRIANGLES {
        let step = triangle_count.div_ceil(MAX_RENDER_TRIANGLES);
        all_triangles.into_iter().step_by(step).collect()
    } else {
        all_triangles
    };
    Ok(ModelGeometry {
        format: path
            .extension()
            .and_then(|extension| extension.to_str())
            .unwrap_or("3D")
            .to_ascii_uppercase(),
        mesh_count,
        vertex_count: vertices.len(),
        triangle_count,
        vertices,
        triangles,
    })
}

fn validate_local_references(path: &Path) -> ServiceResult<()> {
    match path
        .extension()
        .and_then(|extension| extension.to_str())
        .unwrap_or_default()
        .to_ascii_lowercase()
        .as_str()
    {
        "gltf" => {
            let bytes = bounded_reference_read(path)?;
            let document: serde_json::Value = serde_json::from_slice(&bytes).map_err(|error| {
                ServiceError::new(
                    ErrorCode::InvalidInput,
                    format!("Unable to parse glTF manifest: {error}"),
                )
            })?;
            for section in ["buffers", "images"] {
                if let Some(entries) = document.get(section).and_then(serde_json::Value::as_array) {
                    for uri in entries
                        .iter()
                        .filter_map(|entry| entry.get("uri").and_then(serde_json::Value::as_str))
                    {
                        validate_reference(path, uri)?;
                    }
                }
            }
        }
        "obj" => {
            let bytes = bounded_reference_read(path)?;
            let source = String::from_utf8_lossy(&bytes);
            for material in source.lines().filter_map(|line| {
                let line = line.trim();
                line.strip_prefix("mtllib").map(str::trim)
            }) {
                validate_reference(path, material)?;
                let material_path = path
                    .parent()
                    .unwrap_or_else(|| Path::new("."))
                    .join(material);
                if material_path.is_file() {
                    validate_material_references(path, &material_path)?;
                }
            }
        }
        _ => {}
    }
    Ok(())
}

fn validate_material_references(model: &Path, material: &Path) -> ServiceResult<()> {
    let bytes = bounded_reference_read(material)?;
    let source = String::from_utf8_lossy(&bytes);
    for line in source.lines().map(str::trim) {
        let Some((directive, value)) = line.split_once(char::is_whitespace) else {
            continue;
        };
        if directive.to_ascii_lowercase().starts_with("map_") {
            let reference = value.split_whitespace().last().unwrap_or_default();
            validate_reference(model, reference)?;
        }
    }
    Ok(())
}

fn bounded_reference_read(path: &Path) -> ServiceResult<Vec<u8>> {
    let metadata = fs::metadata(path).map_err(ServiceError::from)?;
    if metadata.len() > MAX_REFERENCE_MANIFEST_BYTES {
        return Err(ServiceError::new(
            ErrorCode::Unsupported,
            "3D model manifest exceeds the 16 MiB reference safety limit",
        ));
    }
    fs::read(path).map_err(ServiceError::from)
}

fn validate_reference(source: &Path, reference: &str) -> ServiceResult<()> {
    if reference.starts_with("data:") {
        return Ok(());
    }
    let normalized = reference.replace('\\', "/");
    let lower = normalized.to_ascii_lowercase();
    let unsafe_encoding = ["%2e", "%2f", "%5c"]
        .iter()
        .any(|encoded| lower.contains(encoded));
    let unsafe_component = Path::new(&normalized)
        .components()
        .any(|component| !matches!(component, Component::Normal(_) | Component::CurDir));
    if normalized.is_empty()
        || normalized.contains(':')
        || normalized.starts_with("//")
        || unsafe_encoding
        || unsafe_component
    {
        return Err(ServiceError::new(
            ErrorCode::Unsupported,
            format!("3D preview blocked an external or out-of-folder reference: {reference}"),
        ));
    }
    let root = source.parent().unwrap_or_else(|| Path::new("."));
    let candidate = root.join(&normalized);
    if candidate.exists()
        && let (Ok(root), Ok(candidate)) = (root.canonicalize(), candidate.canonicalize())
        && !candidate.starts_with(root)
    {
        return Err(ServiceError::new(
            ErrorCode::Unsupported,
            "3D preview blocked a reference outside the model folder",
        ));
    }
    Ok(())
}

fn unit_to_byte(value: f32) -> u8 {
    (value.clamp(0.0, 1.0) * 255.0).round() as u8
}

fn mesh_color(index: usize) -> [u8; 3] {
    const COLORS: [[u8; 3]; 6] = [
        [102, 188, 255],
        [126, 231, 177],
        [196, 154, 255],
        [255, 184, 108],
        [255, 126, 166],
        [164, 181, 202],
    ];
    COLORS[index % COLORS.len()]
}

fn normalize_vertices(vertices: &mut [[f32; 3]]) -> ServiceResult<()> {
    let mut min = [f32::INFINITY; 3];
    let mut max = [f32::NEG_INFINITY; 3];
    for vertex in vertices.iter() {
        if vertex.iter().any(|value| !value.is_finite()) {
            return Err(ServiceError::new(
                ErrorCode::InvalidInput,
                "The 3D model contains non-finite vertex coordinates",
            ));
        }
        for axis in 0..3 {
            min[axis] = min[axis].min(vertex[axis]);
            max[axis] = max[axis].max(vertex[axis]);
        }
    }
    let center = [
        (min[0] + max[0]) * 0.5,
        (min[1] + max[1]) * 0.5,
        (min[2] + max[2]) * 0.5,
    ];
    let extent = (max[0] - min[0]).max(max[1] - min[1]).max(max[2] - min[2]);
    if !extent.is_finite() || extent <= f32::EPSILON {
        return Err(ServiceError::new(
            ErrorCode::InvalidInput,
            "The 3D model has no measurable volume",
        ));
    }
    let scale = 2.0 / extent;
    for vertex in vertices {
        for axis in 0..3 {
            vertex[axis] = (vertex[axis] - center[axis]) * scale;
        }
    }
    Ok(())
}

#[derive(Clone, Copy)]
struct ProjectedVertex {
    x: f32,
    y: f32,
    depth: f32,
    view: [f32; 3],
}

fn rasterize(
    geometry: &ModelGeometry,
    camera: ModelCamera,
    width: u32,
    height: u32,
) -> ServiceResult<ModelFrame> {
    let width = width.clamp(240, MAX_FRAME_DIMENSION);
    let height = height.clamp(180, MAX_FRAME_DIMENSION);
    let pixel_count = usize::try_from(u64::from(width) * u64::from(height)).map_err(|_| {
        ServiceError::new(
            ErrorCode::Unsupported,
            "3D preview dimensions are too large",
        )
    })?;
    let mut rgba = vec![0_u8; pixel_count * 4];
    for pixel in rgba.chunks_exact_mut(4) {
        pixel.copy_from_slice(&[13, 17, 23, 255]);
    }
    draw_grid(&mut rgba, width, height);
    let mut depth = vec![f32::INFINITY; pixel_count];

    let yaw = camera.yaw.rem_euclid(std::f32::consts::TAU);
    let pitch = camera.pitch.clamp(-1.45, 1.45);
    let zoom = camera.zoom.clamp(0.25, 4.0);
    let (sy, cy) = yaw.sin_cos();
    let (sp, cp) = pitch.sin_cos();
    let aspect = width as f32 / height as f32;
    let projected = geometry
        .vertices
        .iter()
        .map(|vertex| {
            let x1 = vertex[0] * cy + vertex[2] * sy;
            let z1 = -vertex[0] * sy + vertex[2] * cy;
            let y2 = vertex[1] * cp - z1 * sp;
            let z2 = vertex[1] * sp + z1 * cp;
            let distance = 3.2;
            let camera_z = (z2 + distance).max(0.05);
            let perspective = zoom / camera_z;
            let x = ((x1 * perspective / aspect + camera.pan_x) * 0.5 + 0.5) * width as f32;
            let y = (0.5 - (y2 * perspective + camera.pan_y) * 0.5) * height as f32;
            ProjectedVertex {
                x,
                y,
                depth: camera_z,
                view: [x1, y2, z2],
            }
        })
        .collect::<Vec<_>>();

    for triangle in &geometry.triangles {
        let Some(a) = projected.get(triangle.indices[0] as usize).copied() else {
            continue;
        };
        let Some(b) = projected.get(triangle.indices[1] as usize).copied() else {
            continue;
        };
        let Some(c) = projected.get(triangle.indices[2] as usize).copied() else {
            continue;
        };
        let normal = normalize(cross(sub(b.view, a.view), sub(c.view, a.view)));
        let light = normalize([0.35, -0.55, -1.0]);
        let intensity = (dot(normal, light).abs() * 0.72 + 0.28).clamp(0.18, 1.0);
        let color = [
            (f32::from(triangle.color[0]) * intensity) as u8,
            (f32::from(triangle.color[1]) * intensity) as u8,
            (f32::from(triangle.color[2]) * intensity) as u8,
        ];
        rasterize_triangle(&mut rgba, &mut depth, width, height, [a, b, c], color);
    }

    Ok(ModelFrame {
        width,
        height,
        rgba: rgba.into(),
    })
}

fn draw_grid(rgba: &mut [u8], width: u32, height: u32) {
    let horizon = (height as f32 * 0.74) as u32;
    for x in (0..width).step_by((width / 12).max(16) as usize) {
        for y in horizon..height {
            set_pixel(rgba, width, x, y, [25, 32, 42]);
        }
    }
    for row in 0..6 {
        let t = row as f32 / 6.0;
        let y = horizon + ((height - horizon) as f32 * t * t) as u32;
        for x in 0..width {
            set_pixel(rgba, width, x, y.min(height - 1), [25, 32, 42]);
        }
    }
}

fn set_pixel(rgba: &mut [u8], width: u32, x: u32, y: u32, color: [u8; 3]) {
    let index = (y as usize * width as usize + x as usize) * 4;
    if let Some(pixel) = rgba.get_mut(index..index + 4) {
        pixel.copy_from_slice(&[color[0], color[1], color[2], 255]);
    }
}

fn rasterize_triangle(
    rgba: &mut [u8],
    depth: &mut [f32],
    width: u32,
    height: u32,
    vertices: [ProjectedVertex; 3],
    color: [u8; 3],
) {
    let [a, b, c] = vertices;
    let area = edge(a.x, a.y, b.x, b.y, c.x, c.y);
    if area.abs() < 0.001 {
        return;
    }
    let min_x = a.x.min(b.x).min(c.x).floor().max(0.0) as u32;
    let max_x = a.x.max(b.x).max(c.x).ceil().min(width as f32 - 1.0) as u32;
    let min_y = a.y.min(b.y).min(c.y).floor().max(0.0) as u32;
    let max_y = a.y.max(b.y).max(c.y).ceil().min(height as f32 - 1.0) as u32;
    if min_x > max_x || min_y > max_y {
        return;
    }
    for y in min_y..=max_y {
        for x in min_x..=max_x {
            let px = x as f32 + 0.5;
            let py = y as f32 + 0.5;
            let w0 = edge(b.x, b.y, c.x, c.y, px, py) / area;
            let w1 = edge(c.x, c.y, a.x, a.y, px, py) / area;
            let w2 = 1.0 - w0 - w1;
            if w0 < 0.0 || w1 < 0.0 || w2 < 0.0 {
                continue;
            }
            let z = a.depth * w0 + b.depth * w1 + c.depth * w2;
            let index = y as usize * width as usize + x as usize;
            if z >= depth[index] {
                continue;
            }
            depth[index] = z;
            let pixel = index * 4;
            rgba[pixel..pixel + 4].copy_from_slice(&[color[0], color[1], color[2], 255]);
        }
    }
}

fn edge(ax: f32, ay: f32, bx: f32, by: f32, px: f32, py: f32) -> f32 {
    (px - ax) * (by - ay) - (py - ay) * (bx - ax)
}

fn sub(a: [f32; 3], b: [f32; 3]) -> [f32; 3] {
    [a[0] - b[0], a[1] - b[1], a[2] - b[2]]
}

fn cross(a: [f32; 3], b: [f32; 3]) -> [f32; 3] {
    [
        a[1] * b[2] - a[2] * b[1],
        a[2] * b[0] - a[0] * b[2],
        a[0] * b[1] - a[1] * b[0],
    ]
}

fn dot(a: [f32; 3], b: [f32; 3]) -> f32 {
    a[0] * b[0] + a[1] * b[1] + a[2] * b[2]
}

fn normalize(value: [f32; 3]) -> [f32; 3] {
    let length = dot(value, value).sqrt();
    if length <= f32::EPSILON {
        [0.0, 0.0, 1.0]
    } else {
        [value[0] / length, value[1] / length, value[2] / length]
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;

    #[test]
    fn obj_models_parse_render_and_reuse_the_bounded_cache() {
        let temp = tempfile::tempdir().unwrap();
        let path = temp.path().join("triangle.obj");
        let mut file = fs::File::create(&path).unwrap();
        writeln!(file, "v -1 -1 0\nv 1 -1 0\nv 0 1 0\nf 1 2 3").unwrap();
        let cache = ModelPreviewCache::default();
        let first = cache
            .render(&path, ModelCamera::default(), 480, 320)
            .unwrap();
        assert_eq!(first.format, "OBJ");
        assert_eq!(first.mesh_count, 1);
        assert_eq!(first.vertex_count, 3);
        assert_eq!(first.triangle_count, 1);
        assert_eq!(first.frame.rgba.len(), 480 * 320 * 4);

        let rotated = cache
            .render(
                &path,
                ModelCamera {
                    yaw: 1.2,
                    ..ModelCamera::default()
                },
                480,
                320,
            )
            .unwrap();
        assert_ne!(first.frame.rgba, rotated.frame.rgba);
    }

    #[test]
    fn invalid_and_flat_models_fail_recoverably() {
        let temp = tempfile::tempdir().unwrap();
        let path = temp.path().join("empty.obj");
        fs::write(&path, b"# no geometry\n").unwrap();
        let error = ModelPreviewCache::default()
            .render(&path, ModelCamera::default(), 480, 320)
            .unwrap_err();
        assert!(matches!(error.code, ErrorCode::InvalidInput));
    }

    #[test]
    fn external_and_parent_model_references_are_blocked_before_import() {
        let temp = tempfile::tempdir().unwrap();
        let gltf = temp.path().join("unsafe.gltf");
        fs::write(
            &gltf,
            br#"{"asset":{"version":"2.0"},"buffers":[{"uri":"../outside.bin","byteLength":4}]}"#,
        )
        .unwrap();
        let error = validate_local_references(&gltf).unwrap_err();
        assert_eq!(error.code, ErrorCode::Unsupported);

        fs::write(
            &gltf,
            br#"{"asset":{"version":"2.0"},"buffers":[{"uri":"https://example.com/model.bin","byteLength":4}]}"#,
        )
        .unwrap();
        let error = validate_local_references(&gltf).unwrap_err();
        assert_eq!(error.code, ErrorCode::Unsupported);

        let local = temp.path().join("model.bin");
        fs::write(&local, [0_u8; 4]).unwrap();
        fs::write(
            &gltf,
            br#"{"asset":{"version":"2.0"},"buffers":[{"uri":"model.bin","byteLength":4}]}"#,
        )
        .unwrap();
        validate_local_references(&gltf).unwrap();
    }
}
