package net.deepseek.chat;

import android.content.Context;
import android.content.Intent;
import android.graphics.BitmapFactory;
import android.net.Uri;
import android.os.SystemClock;
import androidx.core.content.FileProvider;
import java.io.BufferedInputStream;
import java.io.File;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.nio.channels.FileChannel;
import java.nio.file.Files;
import java.nio.file.StandardOpenOption;
import java.util.HashMap;
import java.util.HashSet;
import java.util.Iterator;
import java.util.Map;
import java.util.Set;
import java.util.UUID;

/** Main-thread capture ownership; only the bounded snapshot/validation runs off-thread. */
final class CaptureStore {
    static final int CAMERA_GRANTS = Intent.FLAG_GRANT_READ_URI_PERMISSION | Intent.FLAG_GRANT_WRITE_URI_PERMISSION;
    private static final int MAX_FILES = 16;
    private static final long MAX_STORED_BYTES = 128L * 1024 * 1024;
    private static final long MAX_BYTES = AttachmentPolicy.MAX_CAPTURE_BYTES;
    // All Activity instances live on the same main thread. A new instance must not sweep files
    // backed by a different, still-live WebView or camera in this process.
    private static final Set<Photo> occupied = new HashSet<>();

    private final Context context;
    private final String authority;
    private final File directory;
    private final Map<String, Photo> delivered = new HashMap<>();

    CaptureStore(Context context) {
        this.context = context.getApplicationContext();
        authority = context.getPackageName() + ".attachment-captures";
        directory = new File(context.getFilesDir(), "attachment-captures");
    }

    boolean externalContentUri(Uri uri) {
        if (uri == null || !"content".equals(uri.getScheme())) return false;
        String host = uri.getHost();
        return host != null && !host.isEmpty() && !authority.equalsIgnoreCase(host);
    }

    static final class Photo {
        final File stage;
        final File output;
        final Uri stageUri;
        final Uri outputUri;
        AttachmentPolicy.Lease lease;

        Photo(File stage, File output, Uri stageUri, Uri outputUri) {
            this.stage = stage;
            this.output = output;
            this.stageUri = stageUri;
            this.outputUri = outputUri;
        }
    }

    Photo allocate() throws IOException {
        purgeOrphans();
        if ((!directory.isDirectory() && !directory.mkdir()) || directory.getUsableSpace() < MAX_BYTES * 2
                || occupied.size() >= MAX_FILES) throw new IOException("Capture storage unavailable");
        long reserved = 0;
        for (Photo photo : occupied) reserved += photo.lease == null ? MAX_BYTES * 2 : photo.output.length();
        if (reserved + MAX_BYTES * 2 > MAX_STORED_BYTES) throw new IOException("Capture storage limit reached");

        File stage = new File(directory, "chatdemo-camera-output-" + randomId() + ".jpg");
        File output = new File(directory, "chatdemo-capture-" + randomId() + ".jpg");
        if (!stage.createNewFile()) throw new IOException("Camera output file already exists");
        boolean createdOutput = false;
        try {
            if (!(createdOutput = output.createNewFile())) throw new IOException("Capture file already exists");
            Photo photo = new Photo(stage, output, uri(stage), uri(output));
            occupied.add(photo);
            return photo;
        } catch (IOException | RuntimeException e) {
            delete(stage);
            if (createdOutput) delete(output);
            throw e;
        }
    }

    void revokeCamera(Photo photo) { revoke(photo.stageUri); }

    /** Give WebView a different inode that the external camera has never had access to. */
    static boolean snapshot(Photo photo) {
        try {
            if (!photo.stage.isFile() || photo.stage.length() < 4 || photo.stage.length() > MAX_BYTES) return false;
            long size = 0;
            try (InputStream in = Files.newInputStream(photo.stage.toPath());
                 OutputStream out = Files.newOutputStream(photo.output.toPath(), StandardOpenOption.WRITE,
                         StandardOpenOption.TRUNCATE_EXISTING)) { // no CREATE after cancellation unlinks the files
                byte[] buffer = new byte[64 * 1024];
                for (int count; (count = in.read(buffer)) != -1; ) {
                    size += count;
                    if (Thread.currentThread().isInterrupted() || size > MAX_BYTES) return false;
                    out.write(buffer, 0, count);
                }
            }
            if (size < 4 || photo.output.length() != size || Thread.currentThread().isInterrupted()) return false;
            long primarySize;
            try (InputStream input = new BufferedInputStream(Files.newInputStream(photo.output.toPath()), 64 * 1024)) {
                primarySize = AttachmentPolicy.primaryJpegEnd(input);
            }
            if (primarySize < 0 || primarySize > size || Thread.currentThread().isInterrupted()) return false;
            if (primarySize != size) {
                // A Motion Photo can append a video (and potentially audio). Attach the still only.
                try (FileChannel output = FileChannel.open(photo.output.toPath(), StandardOpenOption.WRITE)) {
                    output.truncate(primarySize);
                }
            }
            BitmapFactory.Options bounds = new BitmapFactory.Options();
            bounds.inJustDecodeBounds = true;
            BitmapFactory.decodeFile(photo.output.getPath(), bounds);
            return AttachmentPolicy.validJpeg(primarySize, bounds.outMimeType, bounds.outWidth, bounds.outHeight);
        } catch (IOException | RuntimeException e) { return false; }
    }

    void publish(Photo photo) {
        delete(photo.stage);
        photo.lease = new AttachmentPolicy.Lease(SystemClock.elapsedRealtime());
        delivered.put(photo.output.getName(), photo);
    }

    boolean retain(String name) {
        Photo photo = delivered.get(name);
        if (photo == null) return false;
        if (photo.lease.retain(SystemClock.elapsedRealtime())) return true;
        release(name);
        return false;
    }

    boolean release(String name) {
        Photo photo = delivered.remove(name); // exact unique allocation, never resolve a bridge argument as a path
        if (photo == null) return false;
        discard(photo);
        return true;
    }

    void discard(Photo photo) {
        revokeCamera(photo);
        delete(photo.stage);
        delete(photo.output);
        occupied.remove(photo);
    }

    void discardPage() {
        for (Photo photo : delivered.values()) discard(photo);
        delivered.clear();
        purgeOrphans();
    }

    void purgeOrphans() {
        long now = SystemClock.elapsedRealtime();
        Iterator<Photo> entries = delivered.values().iterator();
        while (entries.hasNext()) {
            Photo photo = entries.next();
            if (photo.lease.expired(now)) {
                entries.remove();
                discard(photo);
            }
        }
        File[] files = directory.listFiles();
        if (files == null) return;
        Set<File> protectedPaths = new HashSet<>();
        for (Photo photo : occupied) {
            protectedPaths.add(photo.stage);
            protectedPaths.add(photo.output);
        }
        for (File file : files) {
            if (protectedPaths.contains(file)) continue;
            boolean cameraStage = AttachmentPolicy.cameraOutputName(file.getName());
            if (!cameraStage && !AttachmentPolicy.captureName(file.getName())) continue;
            if (cameraStage) {
                try { revoke(uri(file)); }
                catch (RuntimeException ignored) { /* Remove an orphan even if grant lookup fails. */ }
            }
            delete(file);
        }
    }

    private static String randomId() { return UUID.randomUUID().toString().replace("-", ""); }

    private Uri uri(File file) { return FileProvider.getUriForFile(context, authority, file); }

    private void revoke(Uri uri) {
        try { context.revokeUriPermission(uri, CAMERA_GRANTS); }
        catch (RuntimeException ignored) { /* The activity or system may have already revoked it. */ }
    }

    private static void delete(File file) {
        try { file.delete(); }
        catch (SecurityException ignored) { /* Best effort; the next orphan sweep can retry. */ }
    }
}
