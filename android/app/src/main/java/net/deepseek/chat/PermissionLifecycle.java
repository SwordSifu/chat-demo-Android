package net.deepseek.chat;

/** Main-thread state: a transient pause is not background; stop invalidates grants permanently. */
final class PermissionLifecycle {
    private boolean started;
    private boolean webPending;
    private boolean runtimePending;
    private int requestCode = 4095;

    void start() { started = true; }
    void pause() { /* Android's own permission dialog can pause a still-visible Activity. */ }
    void stop() { started = false; webPending = false; }
    boolean canRequest() { return started && !webPending && !runtimePending; }

    int beginRuntimeRequest() {
        if (!canRequest()) throw new IllegalStateException("Microphone request is unavailable");
        requestCode = requestCode >= 65534 ? 4096 : requestCode + 1;
        webPending = true;
        runtimePending = true;
        return requestCode;
    }

    void cancelWebRequest() { webPending = false; }
    boolean matchesRuntimeResult(int code) { return runtimePending && code == requestCode; }

    boolean completeRuntimeRequest(int code, boolean granted) {
        if (!matchesRuntimeResult(code)) return false;
        boolean allow = started && webPending && granted;
        runtimePending = false;
        webPending = false;
        return allow;
    }
}
