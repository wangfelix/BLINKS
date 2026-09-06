#include "../../glasses-camera-firmware/ble_recording_policy.h"
#include <cassert>
#include <cstdio>

int main() {
  blinks::ConnectionPolicy p;
  p.reset(1000);
  assert(!p.requestDue(5999, 6, 0)); // Let connection setup finish.
  assert(p.requestDue(6000, 6, 0));
  assert(!p.requestDue(15999, 6, 0)); // No request storm on rejection.
  assert(p.requestDue(16000, 6, 0));
  assert(p.requestDue(26000, 6, 0));
  assert(!p.requestDue(85999, 6, 0));
  assert(p.requestDue(86000, 6, 0)); // Persistent rejection backs off to 60 s.
  assert(!p.requestDue(87000, 40, 0));
  assert(!p.requestDue(90000, 40, 0)); // Accepted settings generate no traffic.
  assert(!p.requestDue(94000, 6, 0));
  assert(p.requestDue(95000, 6, 0)); // Repair a later phone override.
  p.reset(96000); // A new connection gets its own grace period.
  assert(!p.requestDue(100999, 40, 9));
  assert(p.requestDue(101000, 40, 9)); // Interval alone isn't a match.
  p.reset(UINT32_MAX - 2000);
  assert(!p.requestDue(2998, 6, 0));
  assert(p.requestDue(2999, 6, 0)); // millis() wrap remains safe.
  puts("Connection policy: setup, acceptance, overrides, backoff, reconnect, rollover passed");
}
