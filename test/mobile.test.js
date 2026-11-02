import test from 'node:test';
import assert from 'node:assert/strict';
import { isMobileClient } from '../public/js/ui/mobile.js';

const ANDROID = 'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 Chrome/126.0 Mobile Safari/537.36';
const IPHONE = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 Version/17.5 Mobile/15E148 Safari/604.1';
const WINDOWS = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/126.0 Safari/537.36';
const MAC = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 Version/17.5 Safari/605.1.15';

test('phones and tablets get the watch-only version', () => {
  assert.ok(isMobileClient({ userAgent: ANDROID }));
  assert.ok(isMobileClient({ userAgent: IPHONE }));
  assert.ok(isMobileClient({ userAgent: WINDOWS, userAgentData: { mobile: true } }));
  assert.ok(isMobileClient({ userAgent: MAC, platform: 'MacIntel', maxTouchPoints: 5 }), 'iPad se passando por Mac');
});

test('desktops keep the full client, even with a touch screen', () => {
  assert.ok(!isMobileClient({ userAgent: WINDOWS, platform: 'Win32', maxTouchPoints: 10 }));
  assert.ok(!isMobileClient({ userAgent: MAC, platform: 'MacIntel', maxTouchPoints: 0 }));
});

test('the mobile query parameter overrides the device', () => {
  assert.ok(isMobileClient({ userAgent: WINDOWS }, '?mobile=1'));
  assert.ok(!isMobileClient({ userAgent: ANDROID }, '?mobile=0'));
  assert.ok(isMobileClient({ userAgent: ANDROID }, '?profile=a'));
});
