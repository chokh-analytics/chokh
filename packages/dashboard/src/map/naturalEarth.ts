// The projection, in twenty lines, shared by the build script and the browser.
//
// The country outlines are projected once at build time by d3-geo and shipped
// as path strings, so d3 is a devDependency and nothing of it reaches a
// browser. The dots have to be placed at runtime, which means the runtime needs
// the same projection: two implementations of one formula is how a dot ends up
// in the sea next to the country it belongs to.
//
// So there is one implementation, here, and the build script uses it too. The
// test beside this file checks it against d3's own output across five hundred
// coordinates, which is the same shared-vector discipline the collector and
// sdk-node keep for the identify signature.

// Natural Earth 1, written the way d3-geo writes it, term for term.
//
// These are two polynomials in latitude, one scaling longitude and one placing
// latitude, and their exponents are not the regular ladder they look like: the
// x series jumps from the fourth power to the tenth and the y series from the
// second to the sixth. Transcribed as an even ladder it is wrong by
// thirty pixels at the tropics, which is the error the shared vector caught
// before any of this reached a map.

export interface Projection {
  // Where the drawing's own coordinate space begins and how big it is, which is
  // what the build script wrote the paths in.
  width: number;
  height: number;
  scale: number;
  translate: [number, number];
}

function radians(degrees: number): number {
  return (degrees * Math.PI) / 180;
}

// Longitude and latitude in degrees to the projection's own unit square, before
// scale and translation. This is d3's naturalEarth1Raw.
export function naturalEarth1Raw(lonDegrees: number, latDegrees: number): [number, number] {
  const lambda = radians(lonDegrees);
  const phi = radians(latDegrees);
  const phi2 = phi * phi;
  const phi4 = phi2 * phi2;
  return [
    lambda *
      (0.8707 -
        0.131979 * phi2 +
        phi4 * (-0.013791 + phi4 * (0.003971 * phi2 - 0.001529 * phi4))),
    phi *
      (1.007226 +
        phi2 * (0.015085 + phi4 * (-0.044475 + 0.028874 * phi2 - 0.005916 * phi4))),
  ];
}

// And into the drawing, which is what a dot needs. The same scale and translate
// the build script used, carried in the generated file beside the paths.
export function project(
  lonDegrees: number,
  latDegrees: number,
  projection: Projection,
): [number, number] {
  const [x, y] = naturalEarth1Raw(lonDegrees, latDegrees);
  return [
    projection.scale * x + projection.translate[0],
    projection.translate[1] - projection.scale * y,
  ];
}
