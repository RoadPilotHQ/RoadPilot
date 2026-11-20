#version 300 es
// PROTOTYPE (M2): road surface with round caps and joins (distance to the segment), a smoothed
// one-pixel edge, the rail dash (round-capped dashes, as Canvas 2D draws them) and the chord
// opacity. Output is premultiplied alpha.
//
// u_pass selects which fragments are kept, for the stencil passes of the renderer:
//   0 core:   fully covered fragments only
//   1 fringe: partly covered fragments only
//   2 single: every covered fragment (the single pass proposed in M1)
precision highp float;
precision highp int;

in vec2 v_local;
flat in float v_len;
flat in float v_halfWidth;
flat in float v_dist0;
flat in uint v_flags;

uniform vec3 u_color;
uniform float u_chordAlpha;
uniform vec2 u_dash;        // x: dash length, y: period, device px; y = 0: solid
uniform int u_pass;

out vec4 outColor;

const uint FLAG_CHORD = 2u;

void main() {
  float t = clamp(v_local.x, 0.0, v_len);
  float dist = length(vec2(v_local.x - t, v_local.y));

  if (u_dash.y > 0.0) {
    // Like a Canvas 2D dash with round caps: distance to the nearest dash, a capsule of its own.
    float s = mod(v_dist0 + v_local.x, u_dash.y);
    float da = s <= u_dash.x ? 0.0 : min(s - u_dash.x, u_dash.y - s);
    dist = max(dist, length(vec2(da, v_local.y)));
  }
  float cov = clamp(v_halfWidth + 0.5 - dist, 0.0, 1.0);

  if (cov <= 0.0) discard;
  if (u_pass == 0 && cov < 1.0) discard;
  if (u_pass == 1 && cov >= 1.0) discard;

  float a = cov * ((v_flags & FLAG_CHORD) != 0u ? u_chordAlpha : 1.0);
  outColor = vec4(u_color * a, a);
}
