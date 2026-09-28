//! `DirectoryWindow` behavior for search.

use crate::*;

/// Search in this window: whether the search field is active, and the
/// smart-folder search running with its progress.
#[derive(Default)]
pub(crate) struct SearchUi {
    pub(crate) active: bool,
    pub(crate) task: Option<Task<()>>,
    pub(crate) generation: u64,
    pub(crate) request_id: Option<String>,
    pub(crate) progress: Option<SearchProgressEvent>,
}

impl DirectoryWindow {
    pub(crate) fn start_smart_search(&mut self, criteria: SearchCriteria, cx: &mut Context<Self>) {
        self.cancel_watcher_patch();
        self.services.search.cancel();
        self.search.generation = self.search.generation.wrapping_add(1);
        let generation = self.search.generation;
        let request_id = format!(
            "{}-{generation}",
            self.window_lifetime
                .as_ref()
                .map_or("window", |lifetime| lifetime.id.as_str())
        );
        let task = self
            .services
            .search
            .search_with_progress(criteria, request_id.clone());
        self.search.request_id = Some(request_id);
        self.search.progress = None;
        self.browser.replace_entries(Vec::<FileEntry>::new());
        self.listing.state = ListingState::Loading;
        self.status_message = Some("Indexing local files… • Esc to stop".to_string());
        self.search.task = Some(cx.spawn(async move |this, cx| {
            let event = match task.await {
                Ok(result) => SearchEvent::Completed { generation, result },
                Err(error) => SearchEvent::Failed { generation, error },
            };
            let _ = this.update(cx, |view, cx| {
                view.apply_search_event(event, cx);
                cx.notify();
            });
        }));
    }

    pub(crate) fn apply_search_event(&mut self, event: SearchEvent, cx: &mut Context<Self>) {
        match event {
            SearchEvent::Completed { generation, result }
                if generation == self.search.generation
                    && self.browser.active_smart_folder().is_some() =>
            {
                self.search.task = None;
                self.search.request_id = None;
                let status = search_result_status(&result);
                self.browser.replace_entries(result.entries);
                self.listing.state = ListingState::Ready;
                self.status_message = Some(status);
                self.search.progress = None;
                self.finish_pending_preview_refresh(cx);
            }
            SearchEvent::Failed { generation, error }
                if generation == self.search.generation
                    && self.browser.active_smart_folder().is_some() =>
            {
                self.search.task = None;
                self.search.request_id = None;
                self.search.progress = None;
                if error.code == ErrorCode::Cancelled {
                    self.listing.state = ListingState::Ready;
                    self.status_message = Some(format!(
                        "Search stopped • {} partial result(s)",
                        self.browser.visible_entries().len()
                    ));
                    self.watcher.refresh_pending = false;
                    return;
                }
                self.record_error("Smart-folder search failed", error.to_string());
                self.listing.state = ListingState::Failed(error.to_string());
                self.status_message = Some(format!("Smart-folder search failed: {error}"));
            }
            SearchEvent::Completed { .. } | SearchEvent::Failed { .. } => {}
        }
        self.finish_watcher_refresh(cx);
    }

    pub(crate) fn apply_search_progress(
        &mut self,
        progress: SearchProgressEvent,
        cx: &mut Context<Self>,
    ) {
        if self.search.request_id.as_deref() != Some(progress.request_id.as_str())
            || self.browser.active_smart_folder().is_none()
        {
            return;
        }
        if !progress.entries.is_empty() {
            self.browser
                .append_progressive_entries(progress.entries.clone());
            self.listing.state = ListingState::Ready;
        }
        let path = progress
            .current_path
            .file_name()
            .map(|name| name.to_string_lossy().into_owned())
            .unwrap_or_else(|| progress.current_path.display().to_string());
        self.status_message = Some(match progress.phase.as_str() {
            "spotlight" => format!(
                "Searching Spotlight • {} result(s) • Esc to stop",
                progress.matched_entries
            ),
            "indexing" => format!(
                "Indexing {path} • {} paths • Esc to stop",
                progress.indexed_entries
            ),
            "content" => format!(
                "Reading content in {path} • {} paths • Esc to stop",
                progress.indexed_entries
            ),
            _ => format!(
                "Searching {path} • {} result(s) • Esc to stop",
                progress.matched_entries
            ),
        });
        self.search.progress = Some(progress);
        cx.notify();
    }

    pub(crate) fn cancel_smart_search(&mut self, cx: &mut Context<Self>) {
        self.watcher.refresh_pending = false;
        if self.search.task.is_none() {
            return;
        }
        self.services.search.cancel();
        self.search.generation = self.search.generation.wrapping_add(1);
        self.search.task = None;
        self.search.request_id = None;
        self.search.progress = None;
        self.listing.state = ListingState::Ready;
        self.status_message = Some(format!(
            "Search stopped • {} partial result(s)",
            self.browser.visible_entries().len()
        ));
        cx.notify();
    }

    pub(crate) fn rebuild_search_index(&mut self, cx: &mut Context<Self>) {
        let active_criteria = self
            .browser
            .active_smart_folder()
            .map(|folder| folder.criteria().clone());
        if self.search.task.is_some() {
            self.cancel_smart_search(cx);
        }
        self.services.search.clear();
        if let Some(criteria) = active_criteria {
            self.start_smart_search(criteria, cx);
            self.show_toast("Rebuilding the search index", ToastKind::Success, cx);
        } else {
            self.show_toast(
                "Search index cleared; the next search will rebuild it",
                ToastKind::Success,
                cx,
            );
        }
    }

    pub(crate) fn handle_search_key(
        &mut self,
        event: &KeyDownEvent,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        if self.text_input.target.is_some()
            && !matches!(
                event.keystroke.key.as_str(),
                "enter" | "escape" | "up" | "down" | "tab"
            )
        {
            return;
        }
        let is_plain_space = Self::is_plain_space(&event.keystroke);
        if self.quick_look.open {
            if is_plain_space {
                self.handle_quick_look_space_down(event, cx);
                return;
            }
            let is_audio = matches!(
                self.preview.state,
                PreviewState::Ready {
                    content: PreviewContent::Audio,
                    ..
                }
            );
            let is_video = matches!(
                self.preview.state,
                PreviewState::Ready {
                    content: PreviewContent::Video,
                    ..
                }
            );
            match event.keystroke.key.as_str() {
                "escape" if self.quick_look.index_open => self.toggle_quick_look_index(cx),
                "escape" => self.close_quick_look(cx),
                "enter"
                    if event.keystroke.modifiers.platform && self.quick_look.paths.len() > 1 =>
                {
                    self.toggle_quick_look_index(cx)
                }
                "enter" if !event.is_held => {
                    if let Some(path) = self.preview.state.path().map(Path::to_path_buf) {
                        self.open_entry(path, false, cx);
                        self.close_quick_look(cx);
                    }
                }
                "left" | "up" => self.navigate_preview(-1, cx),
                "right" | "down" => self.navigate_preview(1, cx),
                "k" | "j" | "l" | "m" | "home" | "end" if is_audio || is_video => {
                    let (key, is_held) = (event.keystroke.key.clone(), event.is_held);
                    self.media
                        .update(cx, |media, cx| media.handle_shortcut(&key, is_held, cx));
                }
                _ => {}
            }
            cx.stop_propagation();
            return;
        }
        if self.navigation_ui.breadcrumb_editor.is_some() {
            self.handle_breadcrumb_editor_key(event, cx);
            return;
        }
        if self.navigation_ui.go_to_folder.is_some() {
            self.handle_go_to_folder_key(event, cx);
            return;
        }
        if self.settings_ui.shortcut_editor.is_some() {
            self.handle_shortcut_editor_key(event, cx);
            return;
        }
        if self.settings_ui.named_theme_editor.is_some() {
            self.handle_named_theme_key(event, cx);
            return;
        }
        if self.settings_ui.appearance_value_editor.is_some() {
            self.handle_appearance_value_key(event, cx);
            return;
        }
        if self.text_input.target == Some(TextInputTarget::FinderTag) {
            match event.keystroke.key.as_str() {
                "enter" => self.submit_finder_tag(cx),
                "escape" => self.cancel_add_finder_tag(cx),
                _ => {}
            }
            cx.stop_propagation();
            return;
        }
        if self.text_input.target == Some(TextInputTarget::PreviewFind) {
            match event.keystroke.key.as_str() {
                "enter" => self.advance_text_preview_match(1, cx),
                "escape" => {
                    self.preview.text.find.clear();
                    self.deactivate_native_text_input();
                    cx.notify();
                }
                _ => {}
            }
            cx.stop_propagation();
            return;
        }
        if self.operation_ui.undo_progress.is_some() && event.keystroke.key == "escape" {
            self.cancel_undo(cx);
            cx.stop_propagation();
            return;
        }
        if !self.operation_ui.conflict_prompts.is_empty() {
            match event.keystroke.key.as_str() {
                "escape" => self.cancel_all_file_conflicts(cx),
                "enter" | "s" if !event.is_held => {
                    self.resolve_file_conflict(FileConflictChoice::Skip, cx)
                }
                "r" if !event.is_held => {
                    self.resolve_file_conflict(FileConflictChoice::Replace, cx)
                }
                "k" if !event.is_held => {
                    self.resolve_file_conflict(FileConflictChoice::KeepBoth, cx)
                }
                "a" if !event.is_held => self.toggle_file_conflict_apply_to_all(cx),
                _ => {}
            }
            cx.stop_propagation();
            return;
        }
        if self.settings_ui.panel_open {
            match event.keystroke.key.as_str() {
                "escape" => self.close_settings_panel(cx),
                "tab" if event.keystroke.modifiers.shift => window.focus_prev(cx),
                "tab" => window.focus_next(cx),
                _ => {}
            }
            cx.stop_propagation();
            return;
        }
        if self.overlay.toolbar_menu != ToolbarMenu::Closed {
            match event.keystroke.key.as_str() {
                "escape" => self.close_toolbar_menu(cx),
                "down" => window.focus_next(cx),
                "up" => window.focus_prev(cx),
                "tab" if event.keystroke.modifiers.shift => window.focus_prev(cx),
                "tab" => window.focus_next(cx),
                "home" => {
                    if let Some(trigger) = self.overlay.return_focus.as_ref() {
                        window.focus(trigger, cx);
                        window.focus_next(cx);
                    }
                }
                _ => {}
            }
            cx.stop_propagation();
            return;
        }
        if self.overlay.surface != ControlSurface::Closed {
            self.handle_control_surface_key(event, cx);
            return;
        }
        if self.mutation.prompt.is_some() {
            self.handle_mutation_prompt_key(event, cx);
            return;
        }
        if self.preview.tab == PreviewTab::CustomFields
            && self
                .preview
                .custom_fields_editor
                .as_ref()
                .is_some_and(|editor| editor.draft.is_some())
        {
            self.handle_custom_field_key(event, cx);
            return;
        }
        if self.context_menu.menu.is_some() {
            self.handle_context_menu_key(event, cx);
            return;
        }
        if is_plain_space {
            self.handle_quick_look_space_down(event, cx);
            return;
        }
        if !self.search.active {
            self.handle_type_select_key(event, cx);
            return;
        }

        match event.keystroke.key.as_str() {
            "backspace" => {
                self.browser.pop_search_character();
                cx.stop_propagation();
                cx.notify();
            }
            "escape" => {
                self.browser.clear_search();
                self.search.active = false;
                self.deactivate_native_text_input();
                window.focus(&self.focus_handle, cx);
                cx.stop_propagation();
                cx.notify();
            }
            "enter" => {
                self.search.active = false;
                self.deactivate_native_text_input();
                window.focus(&self.focus_handle, cx);
                cx.stop_propagation();
                cx.notify();
            }
            _ if !event.keystroke.modifiers.control
                && !event.keystroke.modifiers.alt
                && !event.keystroke.modifiers.platform =>
            {
                if let Some(text) = event.keystroke.key_char.as_deref()
                    && !text.chars().any(char::is_control)
                {
                    self.browser.push_search_text(text);
                    cx.stop_propagation();
                    cx.notify();
                }
            }
            _ => {}
        }
    }
}

/// The status line for a finished smart-folder search: how many results,
/// whether they are partial, and what answered the search.
pub(crate) fn search_result_status(result: &SearchResult) -> String {
    let count = result.entries.len();
    let crawler_status = || {
        if result.reused_index {
            "cached index".to_string()
        } else if result.content_reads > 0 {
            format!("{} content files indexed", result.content_reads)
        } else {
            format!("{} paths indexed", result.indexed_entries)
        }
    };
    let source = match result.source {
        SearchSource::Spotlight => "Spotlight".to_string(),
        SearchSource::Mixed => format!("Spotlight + {}", crawler_status()),
        SearchSource::Crawler => crawler_status(),
    };
    let results = format!(
        "{count} smart-folder result{}",
        if count == 1 { "" } else { "s" }
    );
    if result.truncated {
        format!("{results} (partial results) • {source}")
    } else {
        format!("{results} • {source}")
    }
}
