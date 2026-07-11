#import "MountHelper.h"
#import <Security/Security.h>
#import <bsm/libbsm.h>
#include <limits.h>
#include <stdlib.h>
#include <string.h>

#ifndef EXPLORIE_TEAM_ID
#define EXPLORIE_TEAM_ID ""
#endif

static NSString *ExplorieRun(NSString *executable, NSArray<NSString *> *arguments) {
    NSTask *task = [[NSTask alloc] init];
    NSPipe *pipe = [NSPipe pipe];
    task.executableURL = [NSURL fileURLWithPath:executable];
    task.arguments = arguments;
    task.standardOutput = pipe;
    task.standardError = pipe;
    NSError *error = nil;
    if (![task launchAndReturnError:&error]) return error.localizedDescription;
    [task waitUntilExit];
    NSData *data = [pipe.fileHandleForReading readDataToEndOfFile];
    NSString *output = [[NSString alloc] initWithData:data encoding:NSUTF8StringEncoding];
    return task.terminationStatus == 0 ? nil : (output.length ? output : @"System mount command failed.");
}

static NSString *ExplorieValidate(NSString *profileID, NSString *volumeName) {
    if (![[NSUUID alloc] initWithUUIDString:profileID]) return @"Invalid profile ID.";
    if (volumeName.length == 0 || volumeName.length > 64 ||
        [volumeName isEqualToString:@"."] || [volumeName isEqualToString:@".."] ||
        [volumeName rangeOfString:@"/"].location != NSNotFound ||
        [volumeName rangeOfString:@"\\"].location != NSNotFound ||
        [volumeName rangeOfCharacterFromSet:NSCharacterSet.controlCharacterSet].location != NSNotFound) {
        return @"Invalid macOS volume name.";
    }
    return nil;
}

static NSString *ExplorieVolumePath(NSString *volumeName) {
    return [@"/Volumes" stringByAppendingPathComponent:volumeName];
}

static NSString *ExplorieRealPath(NSString *path) {
    char resolved[PATH_MAX];
    if (!realpath(path.fileSystemRepresentation, resolved)) return nil;
    return [[NSFileManager defaultManager]
        stringWithFileSystemRepresentation:resolved
        length:strlen(resolved)];
}

static BOOL ExplorieValidatePeer(NSXPCConnection *connection) {
    audit_token_t token = connection.auditToken;
    NSData *audit = [NSData dataWithBytes:&token length:sizeof(token)];
    NSDictionary *attributes = @{(__bridge id)kSecGuestAttributeAudit: audit};
    SecCodeRef code = NULL;
    if (SecCodeCopyGuestWithAttributes(NULL, (__bridge CFDictionaryRef)attributes, kSecCSDefaultFlags, &code) != errSecSuccess) return NO;
    if (SecCodeCheckValidity(code, kSecCSStrictValidate, NULL) != errSecSuccess) {
        CFRelease(code);
        return NO;
    }
    CFDictionaryRef information = NULL;
    BOOL valid = SecCodeCopySigningInformation(code, kSecCSSigningInformation, &information) == errSecSuccess;
    NSDictionary *info = CFBridgingRelease(information);
    CFRelease(code);
    if (!valid || ![info[(__bridge id)kSecCodeInfoIdentifier] isEqualToString:@"com.omershatz.explorie"]) return NO;

    NSURL *executable = info[(__bridge id)kSecCodeInfoMainExecutable];
    NSString *clientPath = ExplorieRealPath(executable.path);
    NSString *helperPath = ExplorieRealPath(NSProcessInfo.processInfo.arguments.firstObject);
    NSString *contentsPath = [[helperPath stringByDeletingLastPathComponent] stringByDeletingLastPathComponent];
    NSString *expectedPath = ExplorieRealPath([contentsPath stringByAppendingPathComponent:@"MacOS/explorie-desktop"]);
    if (!clientPath || !expectedPath || ![executable.path isEqualToString:clientPath] ||
        ![clientPath isEqualToString:expectedPath]) return NO;
    NSString *expectedTeam = @EXPLORIE_TEAM_ID;
    return expectedTeam.length > 0 && [info[(__bridge id)kSecCodeInfoTeamIdentifier] isEqualToString:expectedTeam];
}

@interface ExplorieMountDaemon : NSObject <NSXPCListenerDelegate, ExplorieMountHelperProtocol>
@end

@implementation ExplorieMountDaemon
- (BOOL)listener:(NSXPCListener *)listener shouldAcceptNewConnection:(NSXPCConnection *)connection {
    if (!ExplorieValidatePeer(connection)) return NO;
    connection.exportedInterface = [NSXPCInterface interfaceWithProtocol:@protocol(ExplorieMountHelperProtocol)];
    connection.exportedObject = self;
    [connection resume];
    return YES;
}

- (void)mountProfile:(NSString *)profileID
          volumeName:(NSString *)volumeName
                port:(uint16_t)port
               reply:(void (^)(NSString *))reply {
    NSString *error = ExplorieValidate(profileID, volumeName);
    if (!error && port < 1024) error = @"Invalid loopback NFS port.";
    NSString *path = ExplorieVolumePath(volumeName);
    if (!error && [[NSFileManager defaultManager] fileExistsAtPath:path]) error = @"The requested volume name is already in use.";
    if (!error && ![[NSFileManager defaultManager] createDirectoryAtPath:path withIntermediateDirectories:NO attributes:nil error:nil]) {
        error = @"Unable to create the volume mountpoint.";
    }
    if (!error) {
        NSString *options = [NSString stringWithFormat:@"port=%hu,mountport=%hu,tcp,nolocks", port, port];
        error = ExplorieRun(@"/sbin/mount", @[@"-t", @"nfs", @"-o", options, @"localhost:/", path]);
        if (error) [[NSFileManager defaultManager] removeItemAtPath:path error:nil];
    }
    reply(error);
}

- (void)unmountProfile:(NSString *)profileID
            volumeName:(NSString *)volumeName
                 force:(BOOL)force
                 reply:(void (^)(NSString *))reply {
    NSString *error = ExplorieValidate(profileID, volumeName);
    NSString *path = ExplorieVolumePath(volumeName);
    NSDictionary *attributes = [[NSFileManager defaultManager] attributesOfItemAtPath:path error:nil];
    if (!error && [attributes[NSFileType] isEqualToString:NSFileTypeSymbolicLink]) {
        error = @"Refusing to unmount a symbolic-link volume path.";
    }
    if (!error) {
        NSMutableArray *arguments = [NSMutableArray arrayWithObject:@"unmount"];
        if (force) [arguments addObject:@"force"];
        [arguments addObject:path];
        error = ExplorieRun(@"/usr/sbin/diskutil", arguments);
        if (!error) [[NSFileManager defaultManager] removeItemAtPath:path error:nil];
    }
    reply(error);
}
@end

int main(void) {
    @autoreleasepool {
        ExplorieMountDaemon *daemon = [[ExplorieMountDaemon alloc] init];
        NSXPCListener *listener = [[NSXPCListener alloc] initWithMachServiceName:@"com.omershatz.explorie.mountd"];
        listener.delegate = daemon;
        [listener resume];
        [[NSRunLoop currentRunLoop] run];
    }
    return 0;
}
