package net.deepseek.chat;

import static net.deepseek.chat.AttachmentPolicy.Kind.CAMERA;
import static net.deepseek.chat.AttachmentPolicy.Kind.DOCUMENT;
import static net.deepseek.chat.AttachmentPolicy.Kind.GALLERY;
import static org.junit.Assert.*;

import java.io.ByteArrayInputStream;
import org.junit.Test;

public class AttachmentPolicyTest {
    @Test public void onlyDedicatedWebMarkersUseAttachmentPickers() {
        assertEquals(GALLERY, AttachmentPolicy.chooserKind(new String[]{"image/*"}, false, true));
        assertEquals(GALLERY, AttachmentPolicy.chooserKind(new String[]{"image/*"}, false, false));
        assertEquals(CAMERA, AttachmentPolicy.chooserKind(new String[]{"image/jpeg"}, true, false));
        assertEquals(DOCUMENT, AttachmentPolicy.chooserKind(new String[]{"image/jpeg"}, false, false));
        assertEquals(DOCUMENT, AttachmentPolicy.chooserKind(new String[]{"image/jpeg"}, true, true));
        assertEquals(DOCUMENT, AttachmentPolicy.chooserKind(new String[]{"image/*"}, true, false));
        assertEquals(DOCUMENT, AttachmentPolicy.chooserKind(new String[]{"image/png"}, true, false));
        assertEquals(DOCUMENT, AttachmentPolicy.chooserKind(new String[]{"image/*", "application/zip"}, false, true));
        assertEquals(DOCUMENT, AttachmentPolicy.chooserKind(new String[]{".pdf,.jpg,.zip"}, false, true));
        assertEquals(DOCUMENT, AttachmentPolicy.chooserKind(null, true, false));
    }

    @Test public void releaseMarkerAcceptsOnlyAnExactGeneratedBasename() {
        String id = "0123456789abcdef0123456789abcdef";
        String name = "chatdemo-capture-" + id + ".jpg";
        assertTrue(AttachmentPolicy.captureName(name));
        assertFalse(AttachmentPolicy.captureName("../" + name));
        assertFalse(AttachmentPolicy.captureName("content://camera/" + name));
        assertFalse(AttachmentPolicy.captureName(name + "\n"));
        assertFalse(AttachmentPolicy.captureName(name.replace('a', 'A')));
        assertFalse(AttachmentPolicy.captureName("chatdemo-capture-" + id + ".jpeg"));
        assertFalse(AttachmentPolicy.captureName("chatdemo-camera-output-" + id + ".jpg"));
        assertTrue(AttachmentPolicy.cameraOutputName("chatdemo-camera-output-" + id + ".jpg"));
    }

    @Test public void onlyConcreteImageMimeTypesPassGalleryCheck() {
        assertTrue(AttachmentPolicy.imageMime("image/jpeg"));
        assertTrue(AttachmentPolicy.imageMime("image/SVG+xml"));
        assertFalse(AttachmentPolicy.imageMime("image/*"));
        assertFalse(AttachmentPolicy.imageMime("application/octet-stream"));
        assertFalse(AttachmentPolicy.imageMime("image/"));
        assertFalse(AttachmentPolicy.imageMime(null));
    }

    @Test public void cameraOutputMustBeBoundedAndMatchJpeg() {
        assertTrue(AttachmentPolicy.validJpeg(4096, "image/jpeg", 4000, 3000));
        assertFalse(AttachmentPolicy.validJpeg(0, "image/jpeg", 4000, 3000));
        assertFalse(AttachmentPolicy.validJpeg(AttachmentPolicy.MAX_CAPTURE_BYTES + 1, "image/jpeg", 4000, 3000));
        assertFalse(AttachmentPolicy.validJpeg(4096, "image/png", 4000, 3000));
        assertFalse(AttachmentPolicy.validJpeg(4096, "image/jpeg", 0, 3000));
        assertFalse(AttachmentPolicy.validJpeg(4096, "image/jpeg", 65000, 65000));
    }

    @Test public void cameraKeepsStillJpegAndIgnoresEmbeddedOrTrailingMarkers() throws Exception {
        assertEquals(21, jpegEnd(0xff, 0xd8,
                0xff, 0xe1, 0, 4, 0xff, 0xd9, // an EOI inside the APP1 segment is not the primary end
                0xff, 0xda, 0, 2, 5, 0xff, 0, 0xd9, 0xff, 0xd2, 7, 0xff, 0xd9,
                0, 0, 0, 32, 'f', 't', 'y', 'p'));
        assertEquals(-1, jpegEnd(0x45, 0xd8, 0xff, 0xda, 0, 2, 0xff, 0xd9));
        assertEquals(-1, jpegEnd(0xff, 0xd8, 0xff, 0xda, 0, 2, 0xff));
        assertEquals(-1, jpegEnd(0xff, 0xd8, 0xff, 0xd9));
        assertEquals(17, jpegEnd(0xff, 0xd8, 0xff, 0xda, 0, 2, 5, 0xff, 0xc4, 0, 2,
                0xff, 0xda, 0, 2, 0xff, 0xd9)); // multiple scans, as used by progressive JPEG
    }

    private static long jpegEnd(int... bytes) throws Exception {
        byte[] input = new byte[bytes.length];
        for (int i = 0; i < bytes.length; i++) input[i] = (byte) bytes[i];
        return AttachmentPolicy.primaryJpegEnd(new ByteArrayInputStream(input));
    }

    @Test public void retainedCapturesSurviveLeaseExpiryButUnclaimedCapturesDoNot() {
        long deliveredAt = 1000;
        long expiresAt = deliveredAt + AttachmentPolicy.DELIVERY_LEASE_MS;
        AttachmentPolicy.Lease unclaimed = new AttachmentPolicy.Lease(deliveredAt);
        assertFalse(unclaimed.expired(expiresAt - 1));
        assertTrue(unclaimed.expired(expiresAt));
        assertFalse(unclaimed.retain(expiresAt));

        AttachmentPolicy.Lease retained = new AttachmentPolicy.Lease(deliveredAt);
        assertTrue(retained.retain(expiresAt - 1));
        assertFalse(retained.expired(expiresAt + 1));
        assertTrue(retained.retain(expiresAt + 1));
    }

    @Test public void recreatedActivityKeepsOldResultCodeDistinctUntilConsumed() {
        AttachmentPolicy.RequestCodes original = new AttachmentPolicy.RequestCodes(null);
        int oldCode = original.start();
        AttachmentPolicy.RequestCodes recreated = new AttachmentPolicy.RequestCodes(original.snapshot());
        int current = recreated.start();
        assertNotEquals(oldCode, current);
        assertFalse(recreated.finish(2002)); // SAF save
        assertFalse(recreated.finish(4096)); // microphone permission
        assertTrue(recreated.finish(oldCode));
        assertFalse(recreated.finish(oldCode));
        assertArrayEquals(new int[]{current}, recreated.snapshot());
        assertTrue(recreated.finish(current));
        assertEquals(oldCode, recreated.start());
    }
}
