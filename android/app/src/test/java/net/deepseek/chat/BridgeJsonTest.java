package net.deepseek.chat;

import org.json.JSONException;
import org.json.JSONObject;
import org.junit.Test;
import static org.junit.Assert.*;

public class BridgeJsonTest {
    @Test public void stringIdIsNeverCoercedOrRounded() throws Exception {
        String id = "0009-9007199254740993123456789-中文-\\\"";
        JSONObject request = new JSONObject().put("id", id);
        assertEquals(id, BridgeJson.string(request, "id"));
        assertEquals(id, new JSONObject(BridgeJson.response(id, "token", null, null)).getString("id"));
    }
    @Test public void numericIdsAreRejectedRatherThanCoerced() throws Exception {
        try { BridgeJson.string(new JSONObject().put("id", 9), "id"); fail(); }
        catch (JSONException expected) { }
    }
    @Test public void nullAndMissingStringsAreRejected() throws Exception {
        for (JSONObject input : new JSONObject[]{new JSONObject(), new JSONObject().put("id", JSONObject.NULL)}) {
            try { BridgeJson.string(input, "id"); fail(); }
            catch (JSONException expected) { }
        }
    }
    @Test public void absentKeyIsAnExplicitSuccessfulNull() throws Exception {
        JSONObject reply = new JSONObject(BridgeJson.response("a", null, null, null));
        assertTrue(reply.getBoolean("ok"));
        assertTrue(reply.has("value"));
        assertTrue(reply.isNull("value"));
        assertFalse(reply.has("error"));
    }
    @Test public void failuresAlwaysHaveNonemptyErrorAndNoValue() throws Exception {
        JSONObject reply = new JSONObject(BridgeJson.response("a", null, "native_error", ""));
        assertFalse(reply.getBoolean("ok"));
        assertFalse(reply.has("value"));
        assertFalse(reply.getJSONObject("error").getString("message").isEmpty());
    }
    @Test public void pickerCancellationIsNotSuccess() throws Exception {
        JSONObject reply = new JSONObject(BridgeJson.response("a", null, "cancelled", "Save cancelled"));
        assertFalse(reply.getBoolean("ok"));
        assertEquals("cancelled", reply.getJSONObject("error").getString("code"));
    }
}
