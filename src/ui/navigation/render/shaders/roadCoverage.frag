#version 300 es
// PROTOTYPE (M3): coverage of every road class in one pass, without a stencil.
//
// Each fragment writes its coverage (the same capsule distance, smoothed edge, rail dash and
// chord opacity as road.frag) into the channel of its class: slots 0-3 (draw order rail,
// minor, local, primary) into the first target, slot 4 (motorway) into the second. The
// renderer blends with MAX, so overlapping fragments of one class keep the largest coverage
// instead of the first one (the stencil's error on thin lines) or the sum (darkening). The
// composite pass (composite.frag) then lays the classes over each other in draw order.
precision highp float;
precision highp int;

in vec2 v_local;
flat in float v_len;
flat in float v_halfWidth;
flat in float v_dist0;
flat in uint v_flags;
flat in int v_slot;

uniform float u_chordAlpha;
uniform vec2 u_dashes[5];   // per draw-order slot: x dash length, y period, device px; y = 0: solid

layout(location = 0) out vec4 outLow;   // slots 0-3
layout(location = 1) out vec4 outHigh;  // slot 4 in r

const uint FLAG_CHORD = 2u;

void main() {
  float t = clamp(v_local.x, 0.0, v_len);
  float dist = length(vec2(v_local.x - t, v_local.y));

  vec2 dash = u_dashes[v_slot];
  if (dash.y > 0.0) {
    float s = mod(v_dist0 + v_local.x, dash.y);
    float da = s <= dash.x ? 0.0 : min(s - dash.x, dash.y - s);
    dist = max(dist, length(vec2(da, v_local.y)));
  }
  float cov = clamp(v_halfWidth + 0.5 - dist, 0.0, 1.0);
  if (cov <= 0.0) discard;

  float a = cov * ((v_flags & FLAG_CHORD) != 0u ? u_chordAlpha : 1.0);
  outLow = vec4(equal(ivec4(v_slot), ivec4(0, 1, 2, 3))) * a;
  outHigh = vec4(v_slot == 4 ? a : 0.0, 0.0, 0.0, 0.0);
}
