package net.deepseek.chat;

import android.annotation.SuppressLint;
import android.app.Activity;
import android.content.ClipData;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.os.Process;
import android.os.ext.SdkExtensions;
import android.provider.MediaStore;
import android.webkit.ValueCallback;
import android.webkit.WebChromeClient.FileChooserParams;
import android.widget.Toast;
import java.io.IOException;
import java.util.ArrayList;
import java.util.LinkedHashSet;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.Future;
import java.util.function.BooleanSupplier;

/** Main-thread chooser lifecycle. Never reuse an outstanding request code after a page reset. */
final class AttachmentChooser {
    private static final String OUTSTANDING_CHOOSERS = "attachment.outstandingChoosers";
    private static final int MAX_IMAGES = 50; // Keep in sync with the web attachment count.
    private static final int MAX_GALLERY_CANDIDATES = 512; // Defensive bound for foreign picker results.

    private final Activity activity;
    private final BooleanSupplier trustedPage;
    private final CaptureStore captures;
    private final AttachmentPolicy.RequestCodes codes;
    private final ExecutorService validator = Executors.newSingleThreadExecutor();
    private final Handler main = new Handler(Looper.getMainLooper());
    private final Runnable sweep;
    private Pending pending;

    private static final class Pending {
        final int code;
        final AttachmentPolicy.Kind kind;
        final ValueCallback<Uri[]> callback;
        CaptureStore.Photo photo;
        int limit;
        boolean safOverflow;
        Future<?> validation;

        Pending(int code, AttachmentPolicy.Kind kind, ValueCallback<Uri[]> callback) {
            this.code = code;
            this.kind = kind;
            this.callback = callback;
        }
    }

    AttachmentChooser(Activity activity, Bundle state, BooleanSupplier trustedPage) {
        this.activity = activity;
        this.trustedPage = trustedPage;
        captures = new CaptureStore(activity);
        sweep = captures::purgeOrphans;
        codes = new AttachmentPolicy.RequestCodes(state == null ? null : state.getIntArray(OUTSTANDING_CHOOSERS));
        captures.purgeOrphans();
    }

    void saveState(Bundle out) { out.putIntArray(OUTSTANDING_CHOOSERS, codes.snapshot()); }

    void show(ValueCallback<Uri[]> callback, FileChooserParams params) {
        if (!trustedPage.getAsBoolean()) { deliver(callback, null); return; }
        cancelPending();
        boolean multiple = params.getMode() == FileChooserParams.MODE_OPEN_MULTIPLE;
        String[] types = params.getAcceptTypes();
        AttachmentPolicy.Kind kind = AttachmentPolicy.chooserKind(types, params.isCaptureEnabled(), multiple);
        Pending request;
        try { request = new Pending(codes.start(), kind, callback); }
        catch (IllegalStateException e) { deliver(callback, null); return; }
        pending = request;
        try {
            switch (kind) {
                case CAMERA:
                    request.photo = captures.allocate();
                    Uri uri = request.photo.stageUri;
                    Intent capture = new Intent(MediaStore.ACTION_IMAGE_CAPTURE);
                    capture.putExtra(MediaStore.EXTRA_OUTPUT, uri);
                    capture.setClipData(ClipData.newRawUri("capture", uri));
                    capture.addFlags(CaptureStore.CAMERA_GRANTS);
                    activity.startActivityForResult(capture, request.code);
                    break;
                case GALLERY:
                    if (!launchPhotoPicker(request, multiple)) {
                        request.limit = multiple ? MAX_IMAGES : 1;
                        request.safOverflow = multiple; // Deliver 51 valid images so web rejects the entire batch.
                        activity.startActivityForResult(documentPicker("image/*", multiple), request.code);
                    }
                    break;
                default:
                    activity.startActivityForResult(genericPicker(types, multiple), request.code);
            }
        } catch (IOException | RuntimeException e) {
            codes.finish(request.code);
            complete(request, null);
            if (kind == AttachmentPolicy.Kind.CAMERA) toast(R.string.attachment_camera_unavailable);
            else if (kind == AttachmentPolicy.Kind.GALLERY) toast(R.string.attachment_gallery_unavailable);
        }
    }

    @SuppressLint("NewApi") // Both APIs below are available on 33+, or through the R extension v2.
    private boolean launchPhotoPicker(Pending request, boolean multiple) {
        try {
            if (Build.VERSION.SDK_INT < 33 && (Build.VERSION.SDK_INT < 30
                    || SdkExtensions.getExtensionVersion(Build.VERSION_CODES.R) < 2)) return false;
            Intent picker = new Intent(MediaStore.ACTION_PICK_IMAGES).setType("image/*")
                    .addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION);
            request.limit = 1;
            if (multiple) {
                int max = Math.min(MAX_IMAGES, MediaStore.getPickImagesMaxLimit());
                if (max < 2) return false;
                request.limit = max;
                picker.putExtra(MediaStore.EXTRA_PICK_IMAGES_MAX, max);
            }
            activity.startActivityForResult(picker, request.code);
            return true;
        } catch (RuntimeException | LinkageError unavailable) { return false; }
    }

    private static Intent documentPicker(String type, boolean multiple) {
        return new Intent(Intent.ACTION_OPEN_DOCUMENT).addCategory(Intent.CATEGORY_OPENABLE)
                .setType(type).putExtra(Intent.EXTRA_ALLOW_MULTIPLE, multiple)
                .addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION);
    }

    private static Intent genericPicker(String[] types, boolean multiple) {
        Intent intent = documentPicker("*/*", multiple);
        if (types != null) {
            ArrayList<String> valid = new ArrayList<>();
            for (String type : types) if (type != null && type.matches("[\\w.+*-]+/[\\w.+*-]+")) valid.add(type);
            if (valid.size() == 1) intent.setType(valid.get(0));
            else if (valid.size() > 1) intent.putExtra(Intent.EXTRA_MIME_TYPES, valid.toArray(new String[0]));
        }
        return intent;
    }

    boolean onResult(int code, int resultCode, Intent data) {
        if (!codes.finish(code)) return false;
        Pending request = pending;
        if (request == null || request.code != code) return true; // stale result from a former WebView
        if (resultCode != Activity.RESULT_OK || !trustedPage.getAsBoolean()) {
            complete(request, null);
            return true;
        }
        try {
            if (request.kind == AttachmentPolicy.Kind.CAMERA) {
                // The camera may return a thumbnail, a foreign URI, no data at all, etc. Ignore it.
                captures.revokeCamera(request.photo);
                request.validation = validator.submit(() -> {
                    boolean valid = CaptureStore.snapshot(request.photo);
                    main.post(() -> {
                        if (pending != request) return;
                        complete(request, valid ? new Uri[]{request.photo.outputUri} : null);
                        if (!valid && trustedPage.getAsBoolean()) toast(R.string.attachment_camera_invalid);
                    });
                });
            } else {
                ArrayList<Uri> candidates = contentUris(data);
                if (request.kind == AttachmentPolicy.Kind.DOCUMENT || candidates.isEmpty()) {
                    complete(request, toResult(candidates));
                } else {
                    if (candidates.size() > MAX_GALLERY_CANDIDATES) {
                        complete(request, null);
                        toast(R.string.attachment_gallery_too_many);
                        return true;
                    }
                    request.validation = validator.submit(() -> {
                        ArrayList<Uri> images = new ArrayList<>();
                        for (Uri uri : new LinkedHashSet<>(candidates)) {
                            if (Thread.currentThread().isInterrupted() || images.size() > request.limit) break;
                            try {
                                if (activity.checkUriPermission(uri, Process.myPid(), Process.myUid(),
                                        Intent.FLAG_GRANT_READ_URI_PERMISSION) == PackageManager.PERMISSION_GRANTED
                                        && AttachmentPolicy.imageMime(activity.getContentResolver().getType(uri))) {
                                    images.add(uri);
                                }
                            } catch (RuntimeException ignored) { /* Never pass a broken provider URI to WebView. */ }
                        }
                        main.post(() -> {
                            if (pending != request) return;
                            if (!request.safOverflow && images.size() > request.limit) {
                                complete(request, null);
                                toast(R.string.attachment_gallery_too_many);
                            } else complete(request, toResult(images));
                        });
                    });
                }
            }
        } catch (RuntimeException badResult) { complete(request, null); }
        return true;
    }

    private ArrayList<Uri> contentUris(Intent data) {
        ArrayList<Uri> uris = new ArrayList<>();
        if (data == null) return uris;
        ClipData clips = data.getClipData();
        if (clips != null) {
            for (int i = 0; i < clips.getItemCount(); i++) {
                Uri uri = clips.getItemAt(i).getUri();
                if (captures.externalContentUri(uri)) uris.add(uri);
            }
        } else if (captures.externalContentUri(data.getData())) uris.add(data.getData());
        return uris;
    }

    private static Uri[] toResult(ArrayList<Uri> uris) { return uris.isEmpty() ? null : uris.toArray(new Uri[0]); }

    private void complete(Pending request, Uri[] result) {
        if (pending != request) return;
        pending = null;
        if (!trustedPage.getAsBoolean()) result = null;
        if (request.photo != null) {
            if (result != null) {
                captures.publish(request.photo);
                main.postDelayed(sweep, AttachmentPolicy.DELIVERY_LEASE_MS);
            } else captures.discard(request.photo);
        }
        if (!deliver(request.callback, result) && result != null && request.photo != null) {
            captures.release(request.photo.output.getName());
        }
    }

    private void cancelPending() {
        Pending request = pending;
        if (request == null) return;
        if (request.validation != null) request.validation.cancel(true);
        complete(request, null);
        // If an external Activity is still open, the code stays outstanding until its result arrives.
    }

    void resetPage() {
        cancelPending();
        main.removeCallbacks(sweep);
        captures.discardPage();
    }

    void close() {
        resetPage();
        validator.shutdownNow();
    }

    void purgeOrphans() { captures.purgeOrphans(); }
    boolean externalContentUri(Uri uri) { return captures.externalContentUri(uri); }
    boolean retain(String name) { return captures.retain(name); }
    boolean release(String name) { return captures.release(name); }

    private void toast(int res) { Toast.makeText(activity, res, Toast.LENGTH_SHORT).show(); }

    private static boolean deliver(ValueCallback<Uri[]> callback, Uri[] files) {
        try { callback.onReceiveValue(files); return true; }
        catch (RuntimeException ignored) { return false; /* The old renderer may already have died. */ }
    }
}
