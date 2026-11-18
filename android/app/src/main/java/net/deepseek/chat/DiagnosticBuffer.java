package net.deepseek.chat;

import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.security.GeneralSecurityException;
import java.util.ArrayDeque;
import java.util.Arrays;
import java.util.HashSet;
import java.util.Set;
import org.json.JSONArray;
import org.json.JSONException;
import org.json.JSONObject;

/** Closed diagnostic schema. No URL, message, stack, identifier or user content may enter this buffer. */
final class DiagnosticBuffer {
    static final int MAX_EVENTS = 128;
    static final int MAX_BYTES = 64 * 1024;
    private static final double MAX_SAFE_INTEGER = 9007199254740991d;
    private static final double MAX_DETAIL_NUMBER = 1e12;
    static final int STATUS_GRANTED = 0, STATUS_DENIED = 1, STATUS_CANCELLED = 2,
            STATUS_STALE = 3, STATUS_ERROR = 4;
    enum Event {
        START("native.start"), PERMISSION_REQUEST("native.permission.request"),
        PERMISSION_RESULT("native.permission.result"), PERMISSION_CANCEL("native.permission.cancel"),
        PAUSE("native.lifecycle.pause"), STOP("native.lifecycle.stop"), RESUME("native.lifecycle.resume"),
        RENDERER_GONE("native.renderer.gone"), BRIDGE_ERROR("native.bridge.error");
        final String wire;
        Event(String wire) { this.wire = wire; }
        static Event fromWire(String wire) {
            for (Event event : values()) if (event.wire.equals(wire)) return event;
            return null;
        }
        static Event fromPersistedWire(String wire) {
            Event canonical = fromWire(wire);
            if (canonical != null) return canonical;
            // Exact migration table for the eight legacy names; never prefix arbitrary input.
            switch (wire) {
                case "permission.request": return PERMISSION_REQUEST;
                case "permission.result": return PERMISSION_RESULT;
                case "permission.cancel": return PERMISSION_CANCEL;
                case "lifecycle.pause": return PAUSE;
                case "lifecycle.stop": return STOP;
                case "lifecycle.resume": return RESUME;
                case "renderer.gone": return RENDERER_GONE;
                case "bridge.error": return BRIDGE_ERROR;
                default: return null;
            }
        }
    }
    private static final Set<String> BOOLEAN_FIELDS = new HashSet<>(Arrays.asList("granted", "pending", "crashed"));
    private static final Set<String> NUMBER_FIELDS = new HashSet<>(Arrays.asList("androidSdk", "webViewMajor", "count", "status"));
    private static final Set<String> ERROR_NAMES = new HashSet<>(Arrays.asList("SecurityException", "IllegalArgumentException",
            "IllegalStateException", "JSONException", "IOException", "GeneralSecurityException",
            "RuntimeException", "Exception"));
    private final ArrayDeque<JSONObject> events = new ArrayDeque<>();
    private boolean enabled;

    DiagnosticBuffer(boolean enabled, String persisted) {
        this.enabled = enabled;
        if (persisted == null || persisted.length() > MAX_BYTES
                || persisted.getBytes(StandardCharsets.UTF_8).length > MAX_BYTES) return;
        try {
            JSONArray raw = new JSONArray(persisted);
            // Only the newest bounded tail is relevant; never trust stored object shapes.
            for (int i = Math.max(0, raw.length() - MAX_EVENTS); i < raw.length(); i++) {
                JSONObject item = raw.optJSONObject(i);
                if (item == null || !(item.opt("event") instanceof String)) continue;
                String wire = (String) item.opt("event");
                Event event = Event.fromPersistedWire(wire);
                Object time = item.opt("t");
                if (event == null || !safeTimestamp(time)) continue;
                add(event, ((Number) time).longValue(), migratedDetails(wire, item.optJSONObject("details")));
            }
        } catch (JSONException ignored) { events.clear(); }
    }

    synchronized boolean enabled() { return enabled; }
    synchronized void setEnabled(boolean value) { enabled = value; }
    synchronized void clear() { events.clear(); }
    synchronized void record(Event event, long time, JSONObject details) {
        if (enabled && event != null && time >= 0 && time <= MAX_SAFE_INTEGER) add(event, time, details);
    }
    synchronized String serialized() { return array().toString(); }
    synchronized JSONArray snapshot() {
        try { return new JSONArray(serialized()); }
        catch (JSONException impossible) { throw new IllegalStateException("Invalid diagnostic state"); }
    }

    private void add(Event event, long time, JSONObject details) {
        try {
            events.addLast(new JSONObject().put("t", time).put("event", event.wire)
                    .put("details", sanitize(details)));
            while (events.size() > MAX_EVENTS || serialized().getBytes(StandardCharsets.UTF_8).length > MAX_BYTES) {
                events.removeFirst();
            }
        } catch (JSONException ignored) { /* All emitted values are predefined primitives. */ }
    }

    private JSONArray array() {
        JSONArray array = new JSONArray();
        for (JSONObject item : events) array.put(item);
        return array;
    }

    private static JSONObject sanitize(JSONObject raw) throws JSONException {
        JSONObject clean = new JSONObject();
        if (raw == null) return clean;
        for (String field : BOOLEAN_FIELDS) {
            Object value = raw.opt(field);
            if (value instanceof Boolean) clean.put(field, value);
        }
        for (String field : NUMBER_FIELDS) {
            Object value = raw.opt(field);
            if (safeDetailNumber(value) && (!"status".equals(field) || validStatus((Number) value))) {
                // org.json on the host may parse exponent notation as BigDecimal; normalize it
                // to the same finite numeric primitive used by Android/JavaScript, never its text.
                clean.put(field, value instanceof java.math.BigDecimal || value instanceof java.math.BigInteger
                        ? ((Number) value).doubleValue() : value);
            }
        }
        Object error = raw.opt("errorName");
        if (error instanceof String && ERROR_NAMES.contains(error)) clean.put("errorName", error);
        return clean;
    }

    private static boolean primitiveNumber(Object value) {
        // Reject custom Number implementations whose string conversion could contain private text.
        return value instanceof Integer || value instanceof Long || value instanceof Short
                || value instanceof Byte || value instanceof Double || value instanceof Float
                || (value != null && (value.getClass() == java.math.BigDecimal.class
                || value.getClass() == java.math.BigInteger.class));
    }

    private static boolean safeTimestamp(Object value) {
        if (!primitiveNumber(value)) return false;
        double number = ((Number) value).doubleValue();
        return Double.isFinite(number) && number >= 0 && number <= MAX_SAFE_INTEGER;
    }

    private static boolean safeDetailNumber(Object value) {
        if (!primitiveNumber(value)) return false;
        double number = ((Number) value).doubleValue();
        return Double.isFinite(number) && number >= 0 && number <= MAX_DETAIL_NUMBER;
    }

    private static boolean validStatus(Number value) {
        double number = value.doubleValue();
        return number >= STATUS_GRANTED && number <= STATUS_ERROR && number == Math.rint(number);
    }

    private static JSONObject migratedDetails(String wire, JSONObject raw) throws JSONException {
        JSONObject clean = sanitize(raw);
        if ("permission.result".equals(wire) && raw != null && primitiveNumber(raw.opt("status"))) {
            double legacy = ((Number) raw.opt("status")).doubleValue();
            if (legacy == -1) clean.put("status", STATUS_DENIED);
            else if (legacy == -2) clean.put("status", STATUS_CANCELLED);
        }
        return clean;
    }

    static int permissionStatus(boolean granted, boolean currentRequest, boolean cancelled) {
        if (!currentRequest) return STATUS_STALE;
        if (cancelled) return STATUS_CANCELLED;
        return granted ? STATUS_GRANTED : STATUS_DENIED;
    }

    static String errorName(Throwable error) {
        if (error instanceof SecurityException) return "SecurityException";
        if (error instanceof IllegalArgumentException) return "IllegalArgumentException";
        if (error instanceof IllegalStateException) return "IllegalStateException";
        if (error instanceof JSONException) return "JSONException";
        if (error instanceof IOException) return "IOException";
        if (error instanceof GeneralSecurityException) return "GeneralSecurityException";
        if (error instanceof RuntimeException) return "RuntimeException";
        return "Exception";
    }

    static String safeWebViewVersion(String version) {
        return version != null && version.length() <= 64 && version.matches("[0-9]+(?:\\.[0-9]+){0,3}")
                ? version : "unknown";
    }
}
