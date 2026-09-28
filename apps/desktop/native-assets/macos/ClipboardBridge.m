#import <AppKit/AppKit.h>
#import <Foundation/Foundation.h>
#include <stdint.h>
#include <stdlib.h>
#include <string.h>
#include <sys/stat.h>

// Marks explorie's own "cut" so another explorie window moves instead of
// copying. Finder never writes it, so its copies always paste as copies.
static NSPasteboardType const ExplorieCutMarkerType = @"com.omershatz.explorie.cut";

// A file URL that also carries the cut marker. Every representation is
// written immediately (no promises), so the pasteboard never calls back into
// a process that may have exited.
@interface ExplorieClipboardFile : NSObject <NSPasteboardWriting>
@property(nonatomic, strong) NSURL *url;
@property(nonatomic) BOOL cut;
@end

@implementation ExplorieClipboardFile

- (NSArray<NSPasteboardType> *)writableTypesForPasteboard:(NSPasteboard *)pasteboard {
    NSArray<NSPasteboardType> *types = [self.url writableTypesForPasteboard:pasteboard];
    return self.cut ? [types arrayByAddingObject:ExplorieCutMarkerType] : types;
}

- (id)pasteboardPropertyListForType:(NSPasteboardType)type {
    if ([type isEqualToString:ExplorieCutMarkerType]) return @"cut";
    return [self.url pasteboardPropertyListForType:type];
}

@end

static char *ExplorieClipboardError(NSString *message) {
    return strdup((message ?: @"The clipboard is unavailable.").UTF8String);
}

static NSPasteboard *ExploriePasteboard(const char *name) {
    if (name == NULL) return [NSPasteboard generalPasteboard];
    NSString *pasteboardName = [NSString stringWithUTF8String:name];
    return pasteboardName.length == 0 ? nil : [NSPasteboard pasteboardWithName:pasteboardName];
}

// Replaces the pasteboard contents (the general pasteboard when
// `pasteboard_name` is NULL) with file URLs for `paths`. Returns NULL on
// success or an error message released with explorie_clipboard_free.
char *explorie_clipboard_write_files(
    const char *pasteboard_name,
    const char *const *paths,
    size_t count,
    int32_t cut
) {
    @autoreleasepool {
        NSPasteboard *pasteboard = ExploriePasteboard(pasteboard_name);
        if (pasteboard == nil) return ExplorieClipboardError(@"Invalid pasteboard name.");
        if (paths == NULL || count == 0) return ExplorieClipboardError(@"No files to place on the clipboard.");

        NSMutableArray<ExplorieClipboardFile *> *items = [NSMutableArray arrayWithCapacity:count];
        for (size_t index = 0; index < count; index++) {
            const char *path = paths[index];
            if (path == NULL || path[0] == '\0') return ExplorieClipboardError(@"A file path is invalid.");
            struct stat info;
            BOOL isDirectory = stat(path, &info) == 0 && S_ISDIR(info.st_mode);
            // Built from the raw bytes: +[NSURL fileURLWithPath:] would
            // decompose Unicode and change the bytes of the names.
            NSURL *url = CFBridgingRelease(CFURLCreateFromFileSystemRepresentation(
                kCFAllocatorDefault,
                (const UInt8 *)path,
                (CFIndex)strlen(path),
                isDirectory
            ));
            if (url == nil) return ExplorieClipboardError(@"A file path is invalid.");
            ExplorieClipboardFile *item = [ExplorieClipboardFile new];
            item.url = url;
            item.cut = cut != 0;
            [items addObject:item];
        }

        [pasteboard clearContents];
        if (![pasteboard writeObjects:items]) {
            return ExplorieClipboardError(@"The files could not be placed on the clipboard.");
        }
        return NULL;
    }
}

// Reads file URLs from the pasteboard. Returns 1 and a malloc'd buffer of
// NUL-terminated paths (`out_len` bytes in total, released with
// explorie_clipboard_free) when it holds files, or 0 when it holds none.
int32_t explorie_clipboard_read_files(
    const char *pasteboard_name,
    char **out_paths,
    size_t *out_len,
    int32_t *out_cut
) {
    @autoreleasepool {
        *out_paths = NULL;
        *out_len = 0;
        *out_cut = 0;
        NSPasteboard *pasteboard = ExploriePasteboard(pasteboard_name);
        if (pasteboard == nil) return 0;

        NSArray<NSURL *> *urls = [pasteboard
            readObjectsForClasses:@[ [NSURL class] ]
            options:@{NSPasteboardURLReadingFileURLsOnlyKey: @YES}];
        NSMutableData *buffer = [NSMutableData data];
        for (NSURL *url in urls) {
            // Finder may hand out file reference URLs; resolve them to paths.
            // Use the path as written rather than fileSystemRepresentation,
            // which would decompose Unicode and change the bytes of names.
            NSString *filePath = url.filePathURL.path;
            const char *path = filePath.UTF8String;
            if (filePath.length == 0 || path == NULL) continue;
            [buffer appendBytes:path length:strlen(path) + 1];
        }
        if (buffer.length == 0) return 0;

        char *result = malloc(buffer.length);
        if (result == NULL) return 0;
        memcpy(result, buffer.bytes, buffer.length);
        *out_paths = result;
        *out_len = buffer.length;
        *out_cut = [pasteboard.types containsObject:ExplorieCutMarkerType] ? 1 : 0;
        return 1;
    }
}

// Empties the pasteboard (the general pasteboard when `pasteboard_name` is
// NULL). Returns NULL on success or an error message released with
// explorie_clipboard_free.
char *explorie_clipboard_clear(const char *pasteboard_name) {
    @autoreleasepool {
        NSPasteboard *pasteboard = ExploriePasteboard(pasteboard_name);
        if (pasteboard == nil) return ExplorieClipboardError(@"Invalid pasteboard name.");
        [pasteboard clearContents];
        return NULL;
    }
}

// Discards a named pasteboard created for tests.
void explorie_clipboard_release(const char *pasteboard_name) {
    @autoreleasepool {
        if (pasteboard_name == NULL) return;
        [ExploriePasteboard(pasteboard_name) releaseGlobally];
    }
}

void explorie_clipboard_free(char *value) {
    free(value);
}
