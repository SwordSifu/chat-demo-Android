package net.deepseek.chat;

import android.Manifest;
import android.app.Activity;
import android.app.AlertDialog;
import android.content.ActivityNotFoundException;
import android.content.ClipData;
import android.content.ClipboardManager;
import android.content.Intent;
import android.content.pm.PackageInfo;
import android.content.pm.PackageManager;
import android.graphics.Insets;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.os.Message;
import android.provider.DocumentsContract;
import android.provider.Settings;
import android.view.View;
import android.view.WindowInsets;
import android.webkit.CookieManager;
import android.webkit.PermissionRequest;
import android.webkit.RenderProcessGoneDetail;
import android.webkit.ValueCallback;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceRequest;
import android.webkit.WebResourceResponse;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.FrameLayout;
import android.widget.TextView;
import android.widget.Toast;
import androidx.webkit.JavaScriptReplyProxy;
import androidx.webkit.WebMessageCompat;
import androidx.webkit.WebViewAssetLoader;
import androidx.webkit.WebViewCompat;
import androidx.webkit.WebViewFeature;
import java.io.ByteArrayInputStream;
import java.util.Collections;
import java.util.HashMap;
import java.util.HashSet;
import java.util.Map;
import java.util.Set;
import java.util.UUID;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import org.json.JSONException;
import org.json.JSONObject;

/** A single system WebView, with no bundled browser, background service or wake lock. */
public final class MainActivity extends Activity {
    private static final int CREATE_FILE = 2002;
    private final ExecutorService io = Executors.newSingleThreadExecutor();
    private final Map<String, SaveSession> saves = new HashMap<>(); // IO thread only
    private final Set<String> activeIds = new HashSet<>(); // UI thread only
    private FrameLayout root;
    private WebView web;
    private WebViewAssetLoader assetLoader;
    private KeyStoreVault vault;
    private volatile boolean destroyed;
    private volatile int pageGeneration;
    private PendingReply pendingSave;
    private AttachmentChooser attachments;
    private PermissionRequest pendingMicrophone;
    private final PermissionLifecycle microphoneLifecycle = new PermissionLifecycle();
    private NativeDiagnostics diagnostics;
    private String webViewVersion = "unknown";

    @Override public void onCreate(Bundle state) {
        super.onCreate(state);
        attachments = new AttachmentChooser(this, state, this::trustedCurrentPage);
        try { diagnostics = new NativeDiagnostics(this); }
        catch (RuntimeException ignored) { /* Diagnostics must not prevent normal app startup. */ }
        root = new FrameLayout(this);
        root.setBackgroundColor(0xFFFFFFFF);
        setContentView(root);
        installInsets();
        if (Build.VERSION.SDK_INT >= 33) {
            getOnBackInvokedDispatcher().registerOnBackInvokedCallback(
                    android.window.OnBackInvokedDispatcher.PRIORITY_DEFAULT, this::handleBack);
        }
        boolean supported = false;
        try {
            PackageInfo pkg = WebViewCompat.getCurrentWebViewPackage(this);
            webViewVersion = DiagnosticBuffer.safeWebViewVersion(pkg == null ? null : pkg.versionName);
            int major = "unknown".equals(webViewVersion) ? 0 : Integer.parseInt(webViewVersion.split("\\.")[0]);
            supported = major >= 105 && WebViewFeature.isFeatureSupported(WebViewFeature.WEB_MESSAGE_LISTENER);
        } catch (RuntimeException ignored) { /* Disabled or unavailable WebView provider. */ }
        diagnostic(DiagnosticBuffer.Event.START, "androidSdk", Build.VERSION.SDK_INT,
                "webViewMajor", webViewMajor());
        if (!supported) {
            showWebViewUpdate();
            return;
        }
        vault = new KeyStoreVault(this);
        assetLoader = new WebViewAssetLoader.Builder()
                .addPathHandler("/assets/", new WebViewAssetLoader.AssetsPathHandler(this)).build();
        WebView.setWebContentsDebuggingEnabled(BuildConfig.DEBUG);
        createWebView();
    }

    private void installInsets() {
        if (Build.VERSION.SDK_INT >= 30) getWindow().setDecorFitsSystemWindows(false);
        else root.setSystemUiVisibility(View.SYSTEM_UI_FLAG_LAYOUT_STABLE
                | View.SYSTEM_UI_FLAG_LAYOUT_FULLSCREEN | View.SYSTEM_UI_FLAG_LAYOUT_HIDE_NAVIGATION);
        root.setOnApplyWindowInsetsListener((view, insets) -> {
            int left, top, right, bottom;
            if (Build.VERSION.SDK_INT >= 30) {
                Insets bars = insets.getInsets(WindowInsets.Type.systemBars() | WindowInsets.Type.displayCutout());
                Insets ime = insets.getInsets(WindowInsets.Type.ime());
                left = Math.max(bars.left, ime.left);
                top = bars.top;
                right = Math.max(bars.right, ime.right);
                bottom = Math.max(bars.bottom, ime.bottom);
            } else {
                left = insets.getSystemWindowInsetLeft();
                top = insets.getSystemWindowInsetTop();
                right = insets.getSystemWindowInsetRight();
                bottom = insets.getSystemWindowInsetBottom();
                if (Build.VERSION.SDK_INT >= 28 && insets.getDisplayCutout() != null) {
                    left = Math.max(left, insets.getDisplayCutout().getSafeInsetLeft());
                    top = Math.max(top, insets.getDisplayCutout().getSafeInsetTop());
                    right = Math.max(right, insets.getDisplayCutout().getSafeInsetRight());
                    bottom = Math.max(bottom, insets.getDisplayCutout().getSafeInsetBottom());
                }
            }
            view.setPadding(left, top, right, bottom);
            return Build.VERSION.SDK_INT >= 30 ? WindowInsets.CONSUMED : insets.consumeSystemWindowInsets();
        });
        root.requestApplyInsets();
    }

    private void showWebViewUpdate() {
        TextView text = new TextView(this);
        text.setText(R.string.webview_required);
        text.setPadding(32, 48, 32, 32);
        root.addView(text);
        new AlertDialog.Builder(this).setTitle("Update Android System WebView")
                .setMessage("This app needs a recent secure system WebView (105+). No browser is bundled.")
                .setPositiveButton("Open app settings", (dialog, which) -> {
                    try { startActivity(new Intent(Settings.ACTION_SETTINGS)); }
                    catch (ActivityNotFoundException ignored) { }
                }).setNegativeButton("Close", (dialog, which) -> finish()).show();
    }

    @SuppressWarnings("SetJavaScriptEnabled")
    private void createWebView() {
        if (!WebViewFeature.isFeatureSupported(WebViewFeature.WEB_MESSAGE_LISTENER)) {
            showWebViewUpdate();
            return;
        }
        try { web = new WebView(this); }
        catch (RuntimeException e) { showWebViewUpdate(); return; }
        WebSettings s = web.getSettings();
        s.setJavaScriptEnabled(true);
        s.setDomStorageEnabled(true);
        s.setDatabaseEnabled(false);
        s.setAllowFileAccess(false);
        s.setAllowContentAccess(false);
        s.setAllowFileAccessFromFileURLs(false);
        s.setAllowUniversalAccessFromFileURLs(false);
        s.setMixedContentMode(WebSettings.MIXED_CONTENT_NEVER_ALLOW);
        s.setSafeBrowsingEnabled(true);
        s.setMediaPlaybackRequiresUserGesture(true);
        s.setJavaScriptCanOpenWindowsAutomatically(false);
        s.setSupportMultipleWindows(true);
        s.setGeolocationEnabled(false);
        CookieManager.getInstance().setAcceptThirdPartyCookies(web, false);
        web.setWebViewClient(new SafeClient());
        web.setWebChromeClient(new ChromeClient());
        if (WebViewFeature.isFeatureSupported(WebViewFeature.WEB_MESSAGE_LISTENER)) {
            WebViewCompat.addWebMessageListener(web, "DeepSeekAndroid", Collections.singleton(BridgePolicy.ORIGIN),
                    (view, message, sourceOrigin, isMainFrame, replyProxy) -> {
                        if (!isMainFrame || !BridgePolicy.trustedOrigin(sourceOrigin.toString())
                                || !BridgePolicy.trustedPage(view.getUrl())) return;
                        receive(message, replyProxy);
                    });
        }
        root.addView(web, new FrameLayout.LayoutParams(-1, -1));
        web.loadUrl(BridgePolicy.HOME);
    }

    private boolean trustedCurrentPage() {
        return !destroyed && web != null && BridgePolicy.trustedPage(web.getUrl());
    }

    private final class SafeClient extends WebViewClient {
        @Override public WebResourceResponse shouldInterceptRequest(WebView view, WebResourceRequest request) {
            Uri uri = request.getUrl();
            if (BridgePolicy.trustedOrigin(uri.toString())) {
                WebResourceResponse asset = assetLoader.shouldInterceptRequest(uri);
                return asset != null ? asset : blocked(); // never fall back to DNS for appassets
            }
            return BridgePolicy.allowedApi(uri.toString()) ? null : blocked();
        }
        @Override public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest request) {
            String url = request.getUrl().toString();
            if (!request.isForMainFrame()) return true; // no remote frame navigations
            if (BridgePolicy.trustedPage(url)) return false;
            if (request.hasGesture()) openExternal(url);
            return true;
        }
        @Override public void onPageStarted(WebView view, String url, android.graphics.Bitmap icon) {
            pageGeneration++;
            activeIds.clear();
            cancelUiRequests();
            io.execute(() -> { for (SaveSession session : saves.values()) session.cancel(); saves.clear(); });
            if (!BridgePolicy.trustedPage(url)) view.stopLoading();
        }
        @Override public boolean onRenderProcessGone(WebView view, RenderProcessGoneDetail detail) {
            diagnostic(DiagnosticBuffer.Event.RENDERER_GONE, "crashed", detail.didCrash());
            pageGeneration++;
            cancelUiRequests();
            io.execute(() -> { for (SaveSession session : saves.values()) session.cancel(); saves.clear(); });
            root.removeView(view);
            view.destroy();
            web = null;
            if (!isFinishing() && !destroyed) {
                new AlertDialog.Builder(MainActivity.this).setTitle("WebView stopped")
                        .setMessage("The system stopped the page. Reload it? Unsaved in-memory data may be lost.")
                        .setPositiveButton("Reload", (dialog, which) -> createWebView())
                        .setNegativeButton("Close", (dialog, which) -> finish()).show();
            }
            return true;
        }
    }

    private static WebResourceResponse blocked() {
        return new WebResourceResponse("text/plain", "UTF-8", 403, "Forbidden", Collections.emptyMap(),
                new ByteArrayInputStream(new byte[0]));
    }

    private void openExternal(String url) {
        if (!BridgePolicy.externalUrl(url)) return;
        try { startActivity(new Intent(Intent.ACTION_VIEW, Uri.parse(url)).addCategory(Intent.CATEGORY_BROWSABLE)); }
        catch (ActivityNotFoundException e) { Toast.makeText(this, "No browser is available", Toast.LENGTH_SHORT).show(); }
    }

    private final class ChromeClient extends WebChromeClient {
        @Override public boolean onCreateWindow(WebView view, boolean dialog, boolean userGesture, Message message) {
            if (!userGesture || !trustedCurrentPage()) return false;
            // The temporary view has no JS, storage or bridge; it only resolves target=_blank.
            WebView popup = new WebView(MainActivity.this);
            popup.getSettings().setJavaScriptEnabled(false);
            popup.getSettings().setAllowFileAccess(false);
            popup.getSettings().setAllowContentAccess(false);
            popup.setWebViewClient(new WebViewClient() {
                private boolean handled;
                private void handle(String url) {
                    if (handled) return;
                    handled = true;
                    openExternal(url);
                    popup.post(popup::destroy);
                }
                @Override public boolean shouldOverrideUrlLoading(WebView v, WebResourceRequest r) {
                    handle(r.getUrl().toString()); return true;
                }
                @Override public void onPageStarted(WebView v, String url, android.graphics.Bitmap icon) {
                    handle(url); v.stopLoading();
                }
                @Override public WebResourceResponse shouldInterceptRequest(WebView v, WebResourceRequest r) { return blocked(); }
            });
            popup.postDelayed(() -> { if (popup.getParent() == null) popup.destroy(); }, 5000);
            ((WebView.WebViewTransport) message.obj).setWebView(popup);
            message.sendToTarget();
            return true;
        }

        @Override public boolean onShowFileChooser(WebView view, ValueCallback<Uri[]> callback, FileChooserParams params) {
            if (view != web) callback.onReceiveValue(null);
            else attachments.show(callback, params);
            return true;
        }

        @Override public void onPermissionRequest(PermissionRequest request) {
            diagnostic(DiagnosticBuffer.Event.PERMISSION_REQUEST, "pending", pendingMicrophone != null);
            if (!trustedCurrentPage() || !BridgePolicy.trustedOrigin(request.getOrigin().toString())
                    || !microphoneLifecycle.canRequest()) {
                request.deny();
                diagnostic(DiagnosticBuffer.Event.PERMISSION_RESULT, "granted", false, "status", DiagnosticBuffer.STATUS_DENIED);
                return;
            }
            boolean audio = false;
            for (String resource : request.getResources()) if (PermissionRequest.RESOURCE_AUDIO_CAPTURE.equals(resource)) audio = true;
            if (!audio) {
                request.deny();
                diagnostic(DiagnosticBuffer.Event.PERMISSION_RESULT, "granted", false, "status", DiagnosticBuffer.STATUS_DENIED);
                return;
            }
            if (checkSelfPermission(Manifest.permission.RECORD_AUDIO) == PackageManager.PERMISSION_GRANTED) {
                request.grant(new String[]{PermissionRequest.RESOURCE_AUDIO_CAPTURE});
                diagnostic(DiagnosticBuffer.Event.PERMISSION_RESULT, "granted", true, "pending", false, "status", DiagnosticBuffer.STATUS_GRANTED);
            } else {
                pendingMicrophone = request;
                int code = microphoneLifecycle.beginRuntimeRequest();
                try { requestPermissions(new String[]{Manifest.permission.RECORD_AUDIO}, code); }
                catch (RuntimeException error) {
                    pendingMicrophone = null;
                    microphoneLifecycle.completeRuntimeRequest(code, false);
                    request.deny();
                    diagnostic(DiagnosticBuffer.Event.PERMISSION_RESULT, "granted", false, "status", DiagnosticBuffer.STATUS_ERROR,
                            "errorName", DiagnosticBuffer.errorName(error));
                }
            }
        }
        @Override public void onPermissionRequestCanceled(PermissionRequest request) {
            boolean matched = pendingMicrophone == request;
            if (matched) {
                pendingMicrophone = null;
                microphoneLifecycle.cancelWebRequest();
            }
            diagnostic(DiagnosticBuffer.Event.PERMISSION_CANCEL, "pending", matched, "status", DiagnosticBuffer.STATUS_CANCELLED);
        }
    }

    @Override public void onRequestPermissionsResult(int code, String[] permissions, int[] grants) {
        super.onRequestPermissionsResult(code, permissions, grants);
        if (!microphoneLifecycle.matchesRuntimeResult(code)) return;
        PermissionRequest request = pendingMicrophone;
        pendingMicrophone = null;
        boolean osGranted = permissions.length > 0 && Manifest.permission.RECORD_AUDIO.equals(permissions[0])
                && grants.length > 0 && grants[0] == PackageManager.PERMISSION_GRANTED;
        boolean current = request != null && trustedCurrentPage()
                && BridgePolicy.trustedOrigin(request.getOrigin().toString());
        boolean allow = microphoneLifecycle.completeRuntimeRequest(code, osGranted) && current;
        if (request != null) {
            if (allow) request.grant(new String[]{PermissionRequest.RESOURCE_AUDIO_CAPTURE});
            else request.deny();
        }
        diagnostic(DiagnosticBuffer.Event.PERMISSION_RESULT, "granted", allow, "pending", request != null,
                "count", grants.length, "status", DiagnosticBuffer.permissionStatus(allow, current, grants.length == 0));
    }

    private final class PendingReply {
        final String id;
        final JavaScriptReplyProxy proxy;
        final int generation = pageGeneration;
        boolean answered;
        PendingReply(String id, JavaScriptReplyProxy proxy) { this.id = id; this.proxy = proxy; }
        void success(Object value) { deliver(value, null, null); }
        void error(String code, String message) {
            diagnostic(DiagnosticBuffer.Event.BRIDGE_ERROR);
            deliver(null, code, message);
        }
        void failure(String code, Exception error) {
            diagnostic(DiagnosticBuffer.Event.BRIDGE_ERROR, "errorName", DiagnosticBuffer.errorName(error));
            deliver(null, code, readableError(error));
        }
        private void deliver(Object value, String code, String error) {
            runOnUiThread(() -> {
                if (answered) {
                    return;
                }
                answered = true;
                if (destroyed || generation != pageGeneration || !trustedCurrentPage()) {
                    return;
                }
                activeIds.remove(id);
                if (!WebViewFeature.isFeatureSupported(WebViewFeature.WEB_MESSAGE_LISTENER)) {
                    return;
                }
                try {
                    proxy.postMessage(BridgeJson.response(id, value, code, error));
                } catch (Exception ignored) { /* The originating frame may already have gone away. */ }
            });
        }
    }

    private static String string(JSONObject object, String name) throws JSONException {
        return BridgeJson.string(object, name);
    }

    private void receive(WebMessageCompat message, JavaScriptReplyProxy proxy) {
        if (message.getType() != WebMessageCompat.TYPE_STRING) return;
        String raw = message.getData();
        if (raw == null || raw.length() > BridgePolicy.MAX_MESSAGE_CHARS) return;
        JSONObject request;
        String id;
        try {
            request = new JSONObject(raw);
            id = string(request, "id"); // no numeric conversion: preserve the exact JS string
        } catch (JSONException e) { return; }
        if (!activeIds.add(id)) return; // a duplicate must not settle someone else's promise
        PendingReply reply = new PendingReply(id, proxy);
        try {
            String action = string(request, "action");
            if ("saveBegin".equals(action)) { beginSave(request, reply); return; }
            if ("retainCapturedPhoto".equals(action) || "releaseCapturedPhoto".equals(action)) {
                String name = string(request, "name");
                if (request.length() != 3 || !AttachmentPolicy.captureName(name)) {
                    throw new JSONException("Expected an allocated capture filename");
                }
                runOnUiThread(() -> {
                    if (reply.generation != pageGeneration || !trustedCurrentPage()) return;
                    reply.success("retainCapturedPhoto".equals(action) ? attachments.retain(name) : attachments.release(name));
                });
                return;
            }
            if ("clearWebViewCache".equals(action)) {
                if (request.length() != 2) throw new JSONException("clearWebViewCache does not take arguments");
                runOnUiThread(() -> {
                    if (reply.generation != pageGeneration || !trustedCurrentPage()) return;
                    try {
                        web.clearCache(true);
                        attachments.purgeOrphans();
                        reply.success(null);
                    } catch (RuntimeException e) {
                        // This operation must not write to the existing diagnostics buffer either.
                        reply.deliver(null, "native_error", "WebView cache could not be cleared");
                    }
                });
                return;
            }
            if ("copyText".equals(action)) {
                String text = string(request, "text");
                ClipboardManager clipboard = (ClipboardManager) getSystemService(CLIPBOARD_SERVICE);
                if (clipboard == null) throw new IllegalStateException("Clipboard is unavailable");
                clipboard.setPrimaryClip(ClipData.newPlainText(getString(R.string.app_name), text));
                reply.success(null);
                return;
            }
            io.execute(() -> {
                if (reply.generation != pageGeneration || destroyed) {
                    return;
                }
                try {
                    switch (action) {
                        case "getDiagnostics": {
                            reply.success(requireDiagnostics().snapshot(BuildConfig.VERSION_NAME, BuildConfig.VERSION_CODE,
                                    Build.VERSION.SDK_INT, webViewVersion,
                                    checkSelfPermission(Manifest.permission.RECORD_AUDIO) == PackageManager.PERMISSION_GRANTED,
                                    checkSelfPermission(Manifest.permission.MODIFY_AUDIO_SETTINGS) == PackageManager.PERMISSION_GRANTED));
                            break;
                        }
                        case "setDiagnosticsEnabled": {
                            Object enabled = request.get("enabled");
                            if (!(enabled instanceof Boolean)) throw new JSONException("enabled must be a boolean");
                            requireDiagnostics().setEnabled((Boolean) enabled);
                            reply.success(null); break;
                        }
                        case "clearDiagnostics": requireDiagnostics().clear(); reply.success(null); break;
                        case "getKey": reply.success(vault.get()); break;
                        case "setKey": {
                            Object value = request.get("value");
                            if (value != JSONObject.NULL && !(value instanceof String)) throw new JSONException("value must be string or null");
                            vault.set(value == JSONObject.NULL ? null : (String) value);
                            reply.success(null); break;
                        }
                        case "saveChunk": {
                            String token = string(request, "token");
                            SaveSession session = save(token);
                            try { session.append(BridgePolicy.decodeChunk(string(request, "data"))); }
                            catch (Exception e) { saves.remove(token); session.cancel(); throw e; }
                            reply.success(null); break;
                        }
                        case "saveEnd": {
                            String token = string(request, "token");
                            SaveSession session = save(token);
                            try { session.finish(); }
                            catch (Exception e) { session.cancel(); throw e; }
                            finally { saves.remove(token); }
                            reply.success(null); break;
                        }
                        case "saveCancel": {
                            String token = string(request, "token");
                            SaveSession session = saves.remove(token);
                            if (session != null) session.cancel(); // idempotent cleanup
                            reply.success(null); break;
                        }
                        default: reply.error("unsupported", "Unsupported bridge action");
                    }
                } catch (Exception e) { reply.failure("native_error", e); }
            });
        } catch (Exception e) { reply.failure("invalid_request", e); }
    }

    private int webViewMajor() {
        try { return Integer.parseInt(webViewVersion.split("\\.")[0]); }
        catch (RuntimeException ignored) { return 0; }
    }

    private NativeDiagnostics requireDiagnostics() {
        if (diagnostics == null) throw new IllegalStateException("Native diagnostics are unavailable");
        return diagnostics;
    }

    private void diagnostic(DiagnosticBuffer.Event event, Object... fields) {
        try { if (diagnostics != null) diagnostics.record(event, fields); }
        catch (RuntimeException ignored) { /* Optional logging must never break audio or lifecycle transitions. */ }
    }

    private static String readableError(Exception e) {
        String text = e.getMessage();
        return text == null || text.isEmpty() ? e.getClass().getSimpleName() : text;
    }

    private SaveSession save(String token) {
        SaveSession session = saves.get(token);
        if (session == null) throw new IllegalArgumentException("Unknown or closed save token");
        return session;
    }

    private void beginSave(JSONObject request, PendingReply reply) throws JSONException {
        String name = BridgePolicy.safeName(string(request, "name"));
        String mime = BridgePolicy.mimeType(string(request, "mime"));
        if (pendingSave != null) { reply.error("busy", "A save picker is already open"); return; }
        Intent create = new Intent(Intent.ACTION_CREATE_DOCUMENT).addCategory(Intent.CATEGORY_OPENABLE)
                .setType(mime).putExtra(Intent.EXTRA_TITLE, name)
                .addFlags(Intent.FLAG_GRANT_WRITE_URI_PERMISSION | Intent.FLAG_GRANT_READ_URI_PERMISSION);
        pendingSave = reply;
        try { startActivityForResult(create, CREATE_FILE); }
        catch (RuntimeException e) { pendingSave = null; reply.failure("unavailable", e); }
    }

    @Override public void onActivityResult(int requestCode, int resultCode, Intent data) {
        super.onActivityResult(requestCode, resultCode, data);
        if (attachments.onResult(requestCode, resultCode, data)) return;
        if (requestCode == CREATE_FILE) {
            PendingReply reply = pendingSave;
            pendingSave = null;
            if (reply == null) return;
            Uri uri = data == null ? null : data.getData();
            if (resultCode != RESULT_OK || uri == null) { reply.error("cancelled", "Save cancelled"); return; }
            if (!attachments.externalContentUri(uri)) { reply.error("invalid_uri", "Document provider must return an external content URI"); return; }
            io.execute(() -> {
                if (destroyed || reply.generation != pageGeneration) {
                    try { DocumentsContract.deleteDocument(getContentResolver(), uri); } catch (Exception ignored) { }
                    return;
                }
                try {
                    if (saves.size() >= 4) throw new IllegalStateException("Too many open saves");
                    String token = UUID.randomUUID().toString();
                    saves.put(token, new SaveSession(getContentResolver(), uri));
                    reply.success(token);
                } catch (Exception e) {
                    try { DocumentsContract.deleteDocument(getContentResolver(), uri); } catch (Exception ignored) { }
                    reply.failure("save_failed", e);
                }
            });
        }
    }

    private void cancelUiRequests() {
        cancelSaveAndMicrophone();
        attachments.resetPage();
    }

    private void cancelSaveAndMicrophone() {
        if (pendingSave != null) { pendingSave.error("cancelled", "Page closed"); pendingSave = null; }
        cancelPendingMicrophone();
    }

    private void cancelPendingMicrophone() {
        PermissionRequest request = pendingMicrophone;
        pendingMicrophone = null;
        microphoneLifecycle.cancelWebRequest();
        if (request != null) {
            try {
                request.deny();
                diagnostic(DiagnosticBuffer.Event.PERMISSION_CANCEL, "pending", true, "status", DiagnosticBuffer.STATUS_CANCELLED);
            } catch (RuntimeException error) {
                diagnostic(DiagnosticBuffer.Event.PERMISSION_CANCEL, "pending", true, "status", DiagnosticBuffer.STATUS_CANCELLED,
                        "errorName", DiagnosticBuffer.errorName(error));
            }
        }
    }

    @Override public void onBackPressed() { handleBack(); }

    private void handleBack() {
        if (!trustedCurrentPage()) { finish(); return; }
        final WebView current = web;
        current.evaluateJavascript("(function(){try{return window.__deepseekAndroidBack?.()===true}catch(e){return false}})()", value -> {
            if (!destroyed && current == web && !"true".equals(value)) finish();
        });
    }

    @Override public void onStart() {
        super.onStart();
        microphoneLifecycle.start();
    }

    @Override public void onResume() {
        super.onResume();
        diagnostic(DiagnosticBuffer.Event.RESUME, "pending", pendingMicrophone != null);
    }

    @Override public void onPause() {
        microphoneLifecycle.pause();
        diagnostic(DiagnosticBuffer.Event.PAUSE, "pending", pendingMicrophone != null);
        super.onPause(); // An Android permission dialog may pause us without actually leaving the app.
    }

    @Override public void onStop() {
        microphoneLifecycle.stop(); // Never exempt a pending permission dialog from real backgrounding.
        diagnostic(DiagnosticBuffer.Event.STOP, "pending", pendingMicrophone != null);
        cancelPendingMicrophone();
        if (trustedCurrentPage()) web.evaluateJavascript("try{window.__deepseekAndroidBackground?.()}catch(e){}", null);
        super.onStop(); // Do not pause timers or abort a streaming text chat.
    }

    @Override protected void onSaveInstanceState(Bundle out) {
        super.onSaveInstanceState(out);
        attachments.saveState(out);
    }

    @Override public void onDestroy() {
        destroyed = true;
        microphoneLifecycle.stop();
        cancelSaveAndMicrophone();
        attachments.close();
        io.execute(() -> { for (SaveSession session : saves.values()) session.cancel(); saves.clear(); });
        io.shutdown();
        if (web != null) {
            if (WebViewFeature.isFeatureSupported(WebViewFeature.WEB_MESSAGE_LISTENER)) {
                WebViewCompat.removeWebMessageListener(web, "DeepSeekAndroid");
            }
            root.removeView(web);
            web.stopLoading();
            web.destroy();
            web = null;
        }
        super.onDestroy();
    }
}
