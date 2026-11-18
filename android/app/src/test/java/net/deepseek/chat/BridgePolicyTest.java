package net.deepseek.chat;

import java.util.Arrays;
import java.util.Base64;
import org.junit.Test;
import static org.junit.Assert.*;

public class BridgePolicyTest {
    @Test public void trustedOriginRequiresExactHttpsHostAndPort() {
        assertTrue(BridgePolicy.trustedOrigin(BridgePolicy.ORIGIN));
        assertTrue(BridgePolicy.trustedOrigin(BridgePolicy.ORIGIN + ":443"));
        for (String value : Arrays.asList("http://appassets.androidplatform.net", "https://appassets.androidplatform.net.evil.test", "https://evil@appassets.androidplatform.net", "https://appassets.androidplatform.net:444", "data:text/html,test", "")) {
            assertFalse(value, BridgePolicy.trustedOrigin(value));
        }
        assertTrue(BridgePolicy.trustedPage(BridgePolicy.HOME));
        assertFalse(BridgePolicy.trustedPage(BridgePolicy.ORIGIN + "/other"));
    }
    @Test public void nativeNetworkOnlyAllowsOfficialHttpsApi() {
        assertTrue(BridgePolicy.allowedApi("https://api.deepseek.com/chat/completions"));
        assertTrue(BridgePolicy.allowedApi("https://api.deepseek.com:443/models"));
        for (String url : Arrays.asList("http://api.deepseek.com", "https://api.deepseek.com:444/", "https://api.deepseek.com.evil.test/", "https://x@api.deepseek.com/", "https://example.org/", "content://provider/document/1")) {
            assertFalse(url, BridgePolicy.allowedApi(url));
        }
    }
    @Test public void onlyHttpLinksCanLeaveTheApp() {
        assertTrue(BridgePolicy.externalUrl("https://example.org/path"));
        assertTrue(BridgePolicy.externalUrl("http://example.org"));
        assertFalse(BridgePolicy.externalUrl("intent://example.org"));
        assertFalse(BridgePolicy.externalUrl("file:///tmp/x"));
        assertFalse(BridgePolicy.externalUrl("javascript:alert(1)"));
    }
    @Test public void chunkAcceptsExactLimitAndRejectsOneByteOver() {
        byte[] bytes = new byte[65536];
        Arrays.fill(bytes, (byte) 0xA5);
        assertArrayEquals(bytes, BridgePolicy.decodeChunk(Base64.getEncoder().encodeToString(bytes)));
        try {
            BridgePolicy.decodeChunk(Base64.getEncoder().encodeToString(new byte[65537]));
            fail("over-limit chunk accepted");
        } catch (IllegalArgumentException expected) { }
    }
    @Test public void chunkRejectsInvalidBase64() {
        try { BridgePolicy.decodeChunk("AAAA\nAAAA"); fail(); }
        catch (IllegalArgumentException expected) { }
    }
    @Test public void documentMimeStripsOptionalCharsetParameters() {
        assertEquals("text/plain", BridgePolicy.mimeType("text/plain;charset=utf-8"));
        assertEquals("application/json", BridgePolicy.mimeType(" APPLICATION/JSON "));
        try { BridgePolicy.mimeType("text/plain\r\nbad"); fail(); }
        catch (IllegalArgumentException expected) { }
    }
    @Test public void filenamesCannotContainPathOrControlCharacters() {
        assertEquals(".._test_name_.json", BridgePolicy.safeName("../test\\name\n.json"));
        assertEquals("export", BridgePolicy.safeName("  "));
        assertEquals(180, BridgePolicy.safeName("x".repeat(300)).length());
    }
}
