/**
 * Compute a stable xpath string for an HTMLElement.
 *
 * Strategy:
 *  1. Non-whitespace id  → //*[@id="..."]
 *  2. Otherwise build a positional path: //form/div/input[2]
 *
 * Consistent between Recorder (record time) and Replayer (replay time)
 * so long as the page DOM structure is the same.
 */
export function computeElementXpath(el: HTMLElement): string {
	if (el.id && !/\s/.test(el.id)) {
		return `//*[@id="${el.id}"]`
	}

	const segments: string[] = []
	let current: Element | null = el

	while (current && current.tagName.toUpperCase() !== 'HTML') {
		const parentEl: HTMLElement | null = current.parentElement
		if (!parentEl) break

		const tag = current.tagName.toLowerCase()
		const sameTagSiblings = Array.from(parentEl.children).filter(
			(c: Element) => c.tagName === current!.tagName
		)

		if (sameTagSiblings.length === 1) {
			segments.unshift(tag)
		} else {
			const idx = sameTagSiblings.indexOf(current as Element) + 1
			segments.unshift(`${tag}[${idx}]`)
		}

		current = parentEl
	}

	return '//' + segments.join('/')
}
