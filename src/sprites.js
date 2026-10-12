/**
 * Loads assets/sprites/manifest.json and decodes every frame up front.
 *
 * All frames share one 256px canvas with a common ground line, so a clip change
 * never needs per-frame offsets: blit the whole square and the cat lands in the
 * right place.
 */

function loadImage(src) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error(`could not load sprite ${src}`));
    img.src = src;
  });
}

export async function loadSprites(base) {
  const response = await fetch(`${base}manifest.json`);
  if (!response.ok) {
    throw new Error(
      `no sprite manifest at ${base}manifest.json — run: npm run assets`
    );
  }
  const manifest = await response.json();

  const clips = {};
  await Promise.all(
    Object.entries(manifest.actions).map(async ([name, spec]) => {
      const frames = await Promise.all(spec.frames.map((rel) => loadImage(base + rel)));
      clips[name] = {
        name,
        frames,
        fps: spec.fps,
        loop: spec.loop,
        tags: spec.tags ?? [],
        seconds: frames.length / spec.fps,
      };
    })
  );

  return {
    canvas: manifest.canvas,
    baseline: manifest.baseline,
    // Drawn height of the resting sit, used to size the render box so the cat lands
    // on a fixed number of screen pixels whatever the pipeline's global scale did.
    sitHeight: manifest.sitHeight,
    clips,
  };
}

/** Which frame of a clip is showing after `elapsed` seconds. */
export function frameAt(clip, elapsed) {
  let i = Math.floor(elapsed * clip.fps);
  if (clip.loop) i %= clip.frames.length;
  else i = Math.min(i, clip.frames.length - 1);
  return clip.frames[i];
}
