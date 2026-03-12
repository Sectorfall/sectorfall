export function distance(a, b) {
	return Math.hypot(a.x - b.x, a.y - b.y);
}

export function lerp(a, b, t) {
	return a + (b - a) * t;
}
