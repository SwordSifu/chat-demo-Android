package net.deepseek.chat;

import org.junit.Test;
import static org.junit.Assert.*;

public class PermissionLifecycleTest {
    @Test public void permissionDialogPauseDoesNotCancelAVisibleRequest() {
        PermissionLifecycle state = new PermissionLifecycle();
        state.start();
        int code = state.beginRuntimeRequest();
        state.pause();
        assertTrue(state.completeRuntimeRequest(code, true));
        assertTrue(state.canRequest());
    }
    @Test public void homeDuringPendingDialogRejectsLateGrantEvenAfterReturning() {
        PermissionLifecycle state = new PermissionLifecycle();
        state.start();
        int code = state.beginRuntimeRequest();
        state.pause();
        state.stop();
        state.start();
        assertFalse(state.canRequest()); // old OS callback must drain before another request
        assertFalse(state.completeRuntimeRequest(code, true));
        assertTrue(state.canRequest());
    }
    @Test public void stoppedActivityCannotGrantOrStartMicrophoneRequests() {
        PermissionLifecycle state = new PermissionLifecycle();
        assertFalse(state.canRequest());
        state.start();
        int code = state.beginRuntimeRequest();
        state.stop();
        assertFalse(state.completeRuntimeRequest(code, true));
        assertFalse(state.canRequest());
        try { state.beginRuntimeRequest(); fail(); }
        catch (IllegalStateException expected) { }
    }
    @Test public void canceledWebRequestCannotBeRevivedByOsGrant() {
        PermissionLifecycle state = new PermissionLifecycle();
        state.start();
        int code = state.beginRuntimeRequest();
        state.cancelWebRequest();
        assertFalse(state.canRequest());
        assertFalse(state.completeRuntimeRequest(code, true));
        assertTrue(state.canRequest());
    }
    @Test public void deniedOrEmptyOsResultCannotGrant() {
        PermissionLifecycle state = new PermissionLifecycle();
        state.start();
        int code = state.beginRuntimeRequest();
        assertFalse(state.completeRuntimeRequest(code, false));
        assertTrue(state.canRequest());
    }
    @Test public void staleCallbackCannotSettleTheNextRequest() {
        PermissionLifecycle state = new PermissionLifecycle();
        state.start();
        int previous = state.beginRuntimeRequest();
        assertTrue(state.completeRuntimeRequest(previous, true));
        int next = state.beginRuntimeRequest();
        assertNotEquals(previous, next);
        assertFalse(state.matchesRuntimeResult(previous));
        assertFalse(state.completeRuntimeRequest(previous, true));
        assertTrue(state.matchesRuntimeResult(next));
        assertTrue(state.completeRuntimeRequest(next, true));
    }
    @Test public void duplicateRequestsCannotReplacePendingPermission() {
        PermissionLifecycle state = new PermissionLifecycle();
        state.start();
        int code = state.beginRuntimeRequest();
        assertFalse(state.canRequest());
        try { state.beginRuntimeRequest(); fail(); }
        catch (IllegalStateException expected) { }
        assertTrue(state.completeRuntimeRequest(code, true));
    }
}
