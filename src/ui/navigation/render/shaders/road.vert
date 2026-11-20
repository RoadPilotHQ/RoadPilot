#version 300 es
// PROTOTYPE (M2): one road segment per instance, four vertices (triangle strip).
// The quad covers the segment's capsule (half width + 1 px for the smoothed edge) and hands
// the fragment shader its position in segment space, in device pixels.
precision highp float;
precision highp int;

layout(location = 0) in vec2 a_p0;
layout(location = 1) in vec2 a_p1;
layout(location = 2) in float a_dist0;
layout(location = 3) in uvec2 a_meta; // x: road class, y: road flags

uniform vec2 u_offset;      // tile origin on screen, device px
uniform float u_scale;      // device px per world unit
uniform vec2 u_viewport;    // drawing buffer size, device px
uniform float u_halfWidth[5]; // per road class, device px

out vec2 v_local;           // x: along the segment from p0, y: across, device px
flat out float v_len;
flat out float v_halfWidth;
flat out float v_dist0;     // road length before p0, device px
flat out uint v_flags;

void main() {
  vec2 p0 = u_offset + a_p0 * u_scale;
  vec2 p1 = u_offset + a_p1 * u_scale;
  vec2 d = p1 - p0;
  float len = length(d);
  vec2 dir = len > 1e-4 ? d / len : vec2(1.0, 0.0);
  vec2 nrm = vec2(-dir.y, dir.x);
  float hw = u_halfWidth[min(a_meta.x, 4u)];
  float r = hw + 1.0;

  float along = gl_VertexID >= 2 ? len + r : -r;
  float side = (gl_VertexID & 1) == 0 ? -r : r;
  vec2 pos = p0 + dir * along + nrm * side;

  v_local = vec2(along, side);
  v_len = len;
  v_halfWidth = hw;
  v_dist0 = a_dist0 * u_scale;
  v_flags = a_meta.y;
  gl_Position = vec4(pos.x / u_viewport.x * 2.0 - 1.0, 1.0 - pos.y / u_viewport.y * 2.0, 0.0, 1.0);
}
