package net.deepseek.chat;

import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.security.GeneralSecurityException;
import org.json.JSONArray;
import org.json.JSONObject;
import org.junit.Test;
import static org.junit.Assert.*;

public class DiagnosticBufferTest {
    private static final String PRIVATE = "sk-private-key https://private.example/secret/file.txt private transcript";

    @Test public void closedDetailsSchemaDropsAllPrivateStringsAndUnknownKeys() throws Exception {
        JSONObject raw = new JSONObject().put("url", PRIVATE).put("message", PRIVATE)
                .put("stack", PRIVATE).put("fileName", PRIVATE).put("key", PRIVATE)
                .put("androidId", PRIVATE).put("granted", PRIVATE).put("count", PRIVATE)
                .put("errorName", PRIVATE).put("pending", true).put("status", 1);
        DiagnosticBuffer buffer = new DiagnosticBuffer(true, "[]");
        buffer.record(DiagnosticBuffer.Event.PERMISSION_RESULT, 1234, raw);
        JSONObject event = buffer.snapshot().getJSONObject(0);
        assertEquals(3, event.length());
        JSONObject details = event.getJSONObject("details");
        assertEquals(2, details.length());
        assertTrue(details.getBoolean("pending"));
        assertEquals(1, details.getInt("status"));
        assertFalse(buffer.serialized().contains("private"));
        assertFalse(buffer.serialized().contains("https://"));
    }
    @Test public void acceptsOnlyDefinedScalarDetails() throws Exception {
        JSONObject raw = new JSONObject().put("granted", false).put("pending", true).put("crashed", false)
                .put("androidSdk", 35).put("webViewMajor", 132).put("count", 2).put("status", 1)
                .put("errorName", "IOException").put("unknown", 7);
        DiagnosticBuffer buffer = new DiagnosticBuffer(true, "[]");
        buffer.record(DiagnosticBuffer.Event.BRIDGE_ERROR, 1, raw);
        JSONObject details = buffer.snapshot().getJSONObject(0).getJSONObject("details");
        assertEquals(8, details.length());
        assertEquals("IOException", details.getString("errorName"));
        assertFalse(details.has("unknown"));
    }
    @Test public void retainsOnly128NewestEventsWithinByteBound() throws Exception {
        DiagnosticBuffer buffer = new DiagnosticBuffer(true, "[]");
        for (int i = 0; i < 2000; i++) {
            buffer.record(DiagnosticBuffer.Event.PAUSE, i, new JSONObject().put("count", i));
        }
        assertEquals(128, buffer.snapshot().length());
        assertEquals(1872, buffer.snapshot().getJSONObject(0).getLong("t"));
        assertEquals(1999, buffer.snapshot().getJSONObject(127).getLong("t"));
        assertTrue(buffer.serialized().getBytes(StandardCharsets.UTF_8).length <= 65536);
    }
    @Test public void disabledRecordingAndClearHaveNoSelfGeneratedEvents() throws Exception {
        DiagnosticBuffer buffer = new DiagnosticBuffer(true, "[]");
        buffer.record(DiagnosticBuffer.Event.START, 1, null);
        buffer.setEnabled(false);
        buffer.record(DiagnosticBuffer.Event.PAUSE, 2, null);
        assertEquals(1, buffer.snapshot().length());
        DiagnosticBuffer restored = new DiagnosticBuffer(buffer.enabled(), buffer.serialized());
        assertFalse(restored.enabled());
        restored.clear();
        assertEquals("[]", restored.serialized());
        restored.setEnabled(true);
        restored.record(DiagnosticBuffer.Event.RESUME, 3, null);
        assertEquals(1, restored.snapshot().length());
    }
    @Test public void persistedDataIsSanitizedAndUnknownEventsAreNotRestored() throws Exception {
        JSONArray persisted = new JSONArray()
                .put(new JSONObject().put("t", 1).put("event", PRIVATE).put("details", new JSONObject()))
                .put(new JSONObject().put("t", 2).put("event", "bridge.error").put("url", PRIVATE)
                        .put("details", new JSONObject().put("message", PRIVATE).put("errorName", "IOException")))
                .put(new JSONObject().put("t", PRIVATE).put("event", "native.start"));
        DiagnosticBuffer buffer = new DiagnosticBuffer(true, persisted.toString());
        assertEquals(1, buffer.snapshot().length());
        assertEquals("IOException", buffer.snapshot().getJSONObject(0).getJSONObject("details").getString("errorName"));
        assertFalse(buffer.serialized().contains("private"));
    }
    @Test public void malformedOrOversizedPersistenceIsDiscardedWithoutEchoingIt() {
        assertEquals("[]", new DiagnosticBuffer(true, PRIVATE).serialized());
        assertEquals("[]", new DiagnosticBuffer(true, "x".repeat(65537)).serialized());
        assertEquals("[]", new DiagnosticBuffer(true, "界".repeat(24000)).serialized());
    }
    @Test public void snapshotCannotMutateStoredEvents() throws Exception {
        DiagnosticBuffer buffer = new DiagnosticBuffer(true, "[]");
        buffer.record(DiagnosticBuffer.Event.START, 1, new JSONObject().put("count", 1));
        buffer.snapshot().getJSONObject(0).put("event", PRIVATE).getJSONObject("details").put("message", PRIVATE);
        assertFalse(buffer.serialized().contains("private"));
    }
    @Test public void customNumberCannotSmugglePrivateStrings() throws Exception {
        Number malicious = new Number() {
            public int intValue() { return 1; }
            public long longValue() { return 1; }
            public float floatValue() { return 1; }
            public double doubleValue() { return 1; }
            public String toString() { return PRIVATE; }
        };
        DiagnosticBuffer buffer = new DiagnosticBuffer(true, "[]");
        buffer.record(DiagnosticBuffer.Event.START, 1, new JSONObject().put("count", malicious));
        assertFalse(buffer.snapshot().getJSONObject(0).getJSONObject("details").has("count"));
        assertFalse(buffer.serialized().contains("private"));
    }
    @Test public void unsafeTimestampsAndNumbersAreDiscarded() throws Exception {
        DiagnosticBuffer buffer = new DiagnosticBuffer(true, "[]");
        buffer.record(DiagnosticBuffer.Event.START, -1, null);
        assertEquals(0, buffer.snapshot().length());
        buffer.record(DiagnosticBuffer.Event.START, 1, new JSONObject().put("count", Long.MAX_VALUE));
        assertFalse(buffer.snapshot().getJSONObject(0).getJSONObject("details").has("count"));
    }
    @Test public void exceptionsNeverExposeMessageClassNameOrCause() {
        assertEquals("IOException", DiagnosticBuffer.errorName(new IOException(PRIVATE)));
        assertEquals("SecurityException", DiagnosticBuffer.errorName(new SecurityException(PRIVATE)));
        assertEquals("GeneralSecurityException", DiagnosticBuffer.errorName(new GeneralSecurityException(PRIVATE)));
        assertEquals("RuntimeException", DiagnosticBuffer.errorName(new UnsupportedOperationException(PRIVATE)));
        class PrivateCustomException extends Exception { PrivateCustomException() { super(PRIVATE); } }
        assertEquals("Exception", DiagnosticBuffer.errorName(new PrivateCustomException()));
    }
    @Test public void webViewVersionNeverContainsArbitraryProviderText() {
        assertEquals("132.0.6834.166", DiagnosticBuffer.safeWebViewVersion("132.0.6834.166"));
        assertEquals("unknown", DiagnosticBuffer.safeWebViewVersion(PRIVATE));
        assertEquals("unknown", DiagnosticBuffer.safeWebViewVersion(null));
    }
    @Test public void onlyExplicitLegacyEventsAreMigratedToCanonicalWireNames() throws Exception {
        String[] oldNames = {"permission.request", "permission.result", "permission.cancel", "lifecycle.pause",
                "lifecycle.stop", "lifecycle.resume", "renderer.gone", "bridge.error"};
        String[] newNames = {"native.permission.request", "native.permission.result", "native.permission.cancel", "native.lifecycle.pause",
                "native.lifecycle.stop", "native.lifecycle.resume", "native.renderer.gone", "native.bridge.error"};
        JSONArray persisted = new JSONArray();
        for (int i = 0; i < oldNames.length; i++) {
            persisted.put(new JSONObject().put("t", i).put("event", oldNames[i])
                    .put("details", new JSONObject().put("pending", true)));
            assertNull(DiagnosticBuffer.Event.fromWire(oldNames[i]));
        }
        for (String unknown : new String[]{"permission.injected", "native.native.start", "native.permission.injected", PRIVATE}) {
            persisted.put(new JSONObject().put("t", 9).put("event", unknown));
            assertNull(DiagnosticBuffer.Event.fromPersistedWire(unknown));
        }
        JSONArray snapshot = new DiagnosticBuffer(true, persisted.toString()).snapshot();
        assertEquals(8, snapshot.length());
        for (int i = 0; i < newNames.length; i++) {
            assertEquals(newNames[i], snapshot.getJSONObject(i).getString("event"));
            assertTrue(snapshot.getJSONObject(i).getJSONObject("details").getBoolean("pending"));
        }
    }
    @Test public void legacyNegativePermissionStatusesHaveOnlyFixedMigrations() throws Exception {
        JSONArray persisted = new JSONArray();
        for (int oldStatus : new int[]{-1, -2, -3}) {
            persisted.put(new JSONObject().put("t", 1).put("event", "permission.result")
                    .put("details", new JSONObject().put("status", oldStatus)));
        }
        persisted.put(new JSONObject().put("t", 2).put("event", "native.permission.result")
                .put("details", new JSONObject().put("status", -1)));
        JSONArray snapshot = new DiagnosticBuffer(true, persisted.toString()).snapshot();
        assertEquals(1, snapshot.getJSONObject(0).getJSONObject("details").getInt("status"));
        assertEquals(2, snapshot.getJSONObject(1).getJSONObject("details").getInt("status"));
        assertFalse(snapshot.getJSONObject(2).getJSONObject("details").has("status"));
        assertFalse(snapshot.getJSONObject(3).getJSONObject("details").has("status"));
    }
    @Test public void permissionStatusIsAClosedNonnegativePublicEnum() throws Exception {
        assertEquals(0, DiagnosticBuffer.permissionStatus(true, true, false));
        assertEquals(1, DiagnosticBuffer.permissionStatus(false, true, false));
        assertEquals(2, DiagnosticBuffer.permissionStatus(false, true, true));
        assertEquals(3, DiagnosticBuffer.permissionStatus(false, false, false));
        assertEquals(3, DiagnosticBuffer.permissionStatus(false, false, true));
        assertEquals(4, DiagnosticBuffer.STATUS_ERROR);
        DiagnosticBuffer buffer = new DiagnosticBuffer(true, "[]");
        for (int value = 0; value <= 4; value++) {
            buffer.record(DiagnosticBuffer.Event.PERMISSION_RESULT, value, new JSONObject().put("status", value));
            assertEquals(value, buffer.snapshot().getJSONObject(value).getJSONObject("details").getInt("status"));
        }
        for (double invalid : new double[]{-1, -2, 1.5, 5, 1e13}) {
            DiagnosticBuffer invalidBuffer = new DiagnosticBuffer(true, "[]");
            invalidBuffer.record(DiagnosticBuffer.Event.PERMISSION_RESULT, 1, new JSONObject().put("status", invalid));
            assertFalse(invalidBuffer.snapshot().getJSONObject(0).getJSONObject("details").has("status"));
        }
    }
    @Test public void detailNumbersMatchFrontendNonnegativeTrillionLimitWhileTimestampKeepsEpochMs() throws Exception {
        DiagnosticBuffer buffer = new DiagnosticBuffer(true, "[]");
        long epochMs = 1794900000000L;
        buffer.record(DiagnosticBuffer.Event.START, epochMs, new JSONObject().put("count", 1e12).put("androidSdk", -1).put("webViewMajor", 1e12 + 1));
        JSONObject event = new DiagnosticBuffer(true, buffer.serialized()).snapshot().getJSONObject(0);
        assertEquals(epochMs, event.getLong("t"));
        assertEquals(1e12, event.getJSONObject("details").getDouble("count"), 0);
        assertFalse(event.getJSONObject("details").has("androidSdk"));
        assertFalse(event.getJSONObject("details").has("webViewMajor"));
    }
    @Test public void onlyTaskDefinedEventNamesCanBeEmitted() {
        assertEquals(9, DiagnosticBuffer.Event.values().length);
        assertNull(DiagnosticBuffer.Event.fromWire(PRIVATE));
        for (DiagnosticBuffer.Event event : DiagnosticBuffer.Event.values()) {
            assertSame(event, DiagnosticBuffer.Event.fromWire(event.wire));
        }
    }
}
