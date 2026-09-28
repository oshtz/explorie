#import <AppKit/AppKit.h>
#import <Foundation/Foundation.h>
#import <ImageIO/ImageIO.h>
#import <QuickLookThumbnailing/QuickLookThumbnailing.h>
#import <UniformTypeIdentifiers/UniformTypeIdentifiers.h>
#include <math.h>
#include <stdint.h>
#include <string.h>

// Quick Look thumbnails and NSWorkspace icons rendered to PNG files. Every
// entry point is synchronous, safe to call from any background thread, and
// bounded by a timeout: the system work runs on its own queue and a late
// result is simply dropped.
//
// Result codes; keep in sync with crates/native-services/src/preview/macos.rs.
enum {
    ExploriePreviewImageOK = 0,
    ExploriePreviewImageUnavailable = 1,
    ExploriePreviewImageTimedOut = 2,
    ExploriePreviewImageCancelled = 3,
    ExploriePreviewImageWriteFailed = 4,
    ExploriePreviewImageInvalidInput = 5,
};

// Icon containers for explorie_workspace_type_icon.
enum {
    ExplorieIconContainerFile = 0,
    ExplorieIconContainerFolder = 1,
    ExplorieIconContainerPackage = 2,
};

static const uint32_t ExplorieMaxImagePixels = 4096;

// The PNG produced by asynchronous system work. The completion block keeps it
// alive, so a result that arrives after the caller stopped waiting is released
// with the block instead of touching freed memory.
@interface ExploriePreviewImageResult : NSObject
@property(atomic, strong) NSData *png;
@end

@implementation ExploriePreviewImageResult
@end

static NSString *ExplorieFilePath(const char *path) {
    if (path == NULL) return nil;
    size_t length = strlen(path);
    if (length == 0) return nil;
    NSString *filePath = [[NSFileManager defaultManager] stringWithFileSystemRepresentation:path
                                                                                     length:length];
    return filePath.length > 0 ? filePath : nil;
}

// Draws `image` into an 8-bit sRGB RGBA bitmap of exactly width x height and
// encodes it as PNG. Normalizing keeps 16-bit, floating-point (HDR) and
// wide-gamut system output decodable by the UI's PNG loader.
static NSData *ExploriePNGData(CGImageRef image, size_t width, size_t height) {
    if (image == NULL || width == 0 || height == 0) return nil;
    CGColorSpaceRef colorSpace = CGColorSpaceCreateWithName(kCGColorSpaceSRGB);
    if (colorSpace == NULL) return nil;
    CGContextRef context = CGBitmapContextCreate(
        NULL, width, height, 8, 0, colorSpace,
        (CGBitmapInfo)kCGImageAlphaPremultipliedLast | kCGBitmapByteOrder32Big);
    CGColorSpaceRelease(colorSpace);
    if (context == NULL) return nil;
    CGContextSetInterpolationQuality(context, kCGInterpolationHigh);
    CGContextDrawImage(context, CGRectMake(0, 0, (CGFloat)width, (CGFloat)height), image);
    CGImageRef normalized = CGBitmapContextCreateImage(context);
    CGContextRelease(context);
    if (normalized == NULL) return nil;

    NSMutableData *data = [NSMutableData data];
    CGImageDestinationRef destination = CGImageDestinationCreateWithData(
        (__bridge CFMutableDataRef)data, (__bridge CFStringRef)UTTypePNG.identifier, 1, NULL);
    BOOL encoded = NO;
    if (destination != NULL) {
        CGImageDestinationAddImage(destination, normalized, NULL);
        encoded = CGImageDestinationFinalize(destination);
        CFRelease(destination);
    }
    CGImageRelease(normalized);
    return encoded && data.length > 0 ? data : nil;
}

// The largest size with the image's aspect ratio that fits in a square of
// `limit` pixels. Images are never enlarged.
static void ExplorieFitSize(size_t width, size_t height, size_t limit, size_t *fitWidth,
                            size_t *fitHeight) {
    if (width <= limit && height <= limit) {
        *fitWidth = width;
        *fitHeight = height;
        return;
    }
    double scale = (double)limit / (double)MAX(width, height);
    *fitWidth = MAX((size_t)1, MIN(limit, (size_t)llround((double)width * scale)));
    *fitHeight = MAX((size_t)1, MIN(limit, (size_t)llround((double)height * scale)));
}

// Renders an icon at exactly `pixels` square. The representation is chosen for
// a 1x context of that size, then drawn through Core Graphics, so no AppKit
// focus locking is involved and this is safe off the main thread.
static NSData *ExplorieIconPNG(NSImage *icon, uint32_t pixels) {
    if (icon == nil) return nil;
    NSRect proposed = NSMakeRect(0, 0, pixels, pixels);
    NSDictionary<NSImageHintKey, id> *hints = @{NSImageHintCTM : [NSAffineTransform transform]};
    CGImageRef image = [icon CGImageForProposedRect:&proposed context:nil hints:hints];
    return ExploriePNGData(image, pixels, pixels);
}

// Waits for `done` in short slices until `timeoutSeconds` pass, returning
// early when `generation` (if any) no longer equals `ticket` because a newer
// preview superseded this one.
static int32_t ExplorieWait(dispatch_semaphore_t done, double timeoutSeconds,
                            const uint64_t *generation, uint64_t ticket) {
    CFAbsoluteTime deadline = CFAbsoluteTimeGetCurrent() + MAX(timeoutSeconds, 0.0);
    for (;;) {
        if (generation != NULL && __atomic_load_n(generation, __ATOMIC_ACQUIRE) != ticket) {
            return ExploriePreviewImageCancelled;
        }
        CFAbsoluteTime remaining = deadline - CFAbsoluteTimeGetCurrent();
        if (remaining <= 0) {
            return dispatch_semaphore_wait(done, DISPATCH_TIME_NOW) == 0
                       ? ExploriePreviewImageOK
                       : ExploriePreviewImageTimedOut;
        }
        int64_t slice = (int64_t)(MIN(remaining, 0.05) * (double)NSEC_PER_SEC);
        if (dispatch_semaphore_wait(done, dispatch_time(DISPATCH_TIME_NOW, slice)) == 0) {
            return ExploriePreviewImageOK;
        }
    }
}

static int32_t ExplorieWritePNG(NSData *png, NSString *outputPath) {
    if (png == nil) return ExploriePreviewImageUnavailable;
    return [png writeToFile:outputPath options:NSDataWritingAtomic error:nil]
               ? ExploriePreviewImageOK
               : ExploriePreviewImageWriteFailed;
}

// Runs `loader` on a background queue and writes its icon as a PNG of
// `pixels` square to `outputPath`.
static int32_t ExplorieRenderIcon(NSImage * (^loader)(void), uint32_t pixels, double timeoutSeconds,
                                  NSString *outputPath) {
    ExploriePreviewImageResult *result = [ExploriePreviewImageResult new];
    dispatch_semaphore_t done = dispatch_semaphore_create(0);
    dispatch_async(dispatch_get_global_queue(QOS_CLASS_USER_INITIATED, 0), ^{
      @autoreleasepool {
          result.png = ExplorieIconPNG(loader(), pixels);
      }
      dispatch_semaphore_signal(done);
    });
    int32_t waited = ExplorieWait(done, timeoutSeconds, NULL, 0);
    if (waited != ExploriePreviewImageOK) return waited;
    return ExplorieWritePNG(result.png, outputPath);
}

// Writes Quick Look's thumbnail of `path`, fitted within `max_pixels` square,
// to `output` as PNG. Only real thumbnails count: a file type Quick Look can
// only draw as an icon reports Unavailable. `generation`, when not NULL, is
// read atomically; the wait stops once it no longer equals `ticket`.
int32_t explorie_quicklook_thumbnail(const char *path, uint32_t max_pixels, double timeout_seconds,
                                     const char *output, const uint64_t *generation,
                                     uint64_t ticket) {
    @autoreleasepool {
        NSString *filePath = ExplorieFilePath(path);
        NSString *outputPath = ExplorieFilePath(output);
        if (filePath == nil || outputPath == nil || max_pixels == 0 ||
            max_pixels > ExplorieMaxImagePixels) {
            return ExploriePreviewImageInvalidInput;
        }

        QLThumbnailGenerationRequest *request = [[QLThumbnailGenerationRequest alloc]
              initWithFileAtURL:[NSURL fileURLWithPath:filePath]
                           size:CGSizeMake(max_pixels, max_pixels)
                          scale:1.0
            representationTypes:QLThumbnailGenerationRequestRepresentationTypeThumbnail];
        ExploriePreviewImageResult *result = [ExploriePreviewImageResult new];
        dispatch_semaphore_t done = dispatch_semaphore_create(0);
        QLThumbnailGenerator *generator = [QLThumbnailGenerator sharedGenerator];
        [generator generateBestRepresentationForRequest:request
                                      completionHandler:^(QLThumbnailRepresentation *representation,
                                                          NSError *error) {
                                        (void)error;
                                        @autoreleasepool {
                                            CGImageRef image = representation.CGImage;
                                            if (image != NULL) {
                                                size_t width = 0;
                                                size_t height = 0;
                                                ExplorieFitSize(CGImageGetWidth(image),
                                                                CGImageGetHeight(image), max_pixels,
                                                                &width, &height);
                                                result.png = ExploriePNGData(image, width, height);
                                            }
                                        }
                                        dispatch_semaphore_signal(done);
                                      }];
        int32_t waited = ExplorieWait(done, timeout_seconds, generation, ticket);
        if (waited != ExploriePreviewImageOK) {
            [generator cancelRequest:request];
            return waited;
        }
        return ExplorieWritePNG(result.png, outputPath);
    }
}

// Writes the icon NSWorkspace shows for the item at `path` (an application's
// own icon, a special folder's, an alias's target) as a `pixels` square PNG.
int32_t explorie_workspace_file_icon(const char *path, uint32_t pixels, double timeout_seconds,
                                     const char *output) {
    @autoreleasepool {
        NSString *filePath = ExplorieFilePath(path);
        NSString *outputPath = ExplorieFilePath(output);
        if (filePath == nil || outputPath == nil || pixels == 0 || pixels > ExplorieMaxImagePixels) {
            return ExploriePreviewImageInvalidInput;
        }
        return ExplorieRenderIcon(
            ^NSImage * {
              return [[NSWorkspace sharedWorkspace] iconForFile:filePath];
            },
            pixels, timeout_seconds, outputPath);
    }
}

// Writes the icon every item of a kind shares: a regular file or package with
// filename `extension` (empty for none), or a plain folder. It never touches
// an actual file, so it is safe for cloud placeholders.
int32_t explorie_workspace_type_icon(const char *extension, int32_t container, uint32_t pixels,
                                     double timeout_seconds, const char *output) {
    @autoreleasepool {
        NSString *outputPath = ExplorieFilePath(output);
        if (outputPath == nil || pixels == 0 || pixels > ExplorieMaxImagePixels ||
            container < ExplorieIconContainerFile || container > ExplorieIconContainerPackage) {
            return ExploriePreviewImageInvalidInput;
        }
        NSString *filenameExtension =
            extension == NULL ? @"" : ([NSString stringWithUTF8String:extension] ?: @"");
        UTType *type = UTTypeFolder;
        if (container != ExplorieIconContainerFolder) {
            UTType *conformance =
                container == ExplorieIconContainerPackage ? UTTypePackage : UTTypeData;
            type = filenameExtension.length > 0
                       ? [UTType typeWithFilenameExtension:filenameExtension
                                          conformingToType:conformance]
                       : nil;
            if (type == nil) type = conformance;
        }
        return ExplorieRenderIcon(
            ^NSImage * {
              return [[NSWorkspace sharedWorkspace] iconForContentType:type];
            },
            pixels, timeout_seconds, outputPath);
    }
}

// 1 when icons currently draw in a dark appearance, else 0. Icons follow the
// system appearance, so cached renderings are keyed by it.
int32_t explorie_icon_appearance_is_dark(void) {
    @autoreleasepool {
        NSAppearanceName name = [[NSAppearance currentDrawingAppearance]
            bestMatchFromAppearancesWithNames:@[ NSAppearanceNameAqua, NSAppearanceNameDarkAqua ]];
        return [name isEqualToString:NSAppearanceNameDarkAqua] ? 1 : 0;
    }
}
