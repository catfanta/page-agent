/**
 * 3D soldier model viewer.
 *
 * Loads a glTF model and exposes `window.playAnimation(name)` /
 * `window.getAnimationList()` so the OpenHuman agent can trigger animations
 * from the page. The canvas is a fixed, click-through overlay that follows the
 * OpenHumanPanel: it anchors to the element marked `data-openhuman-panel` and
 * falls back to the panel's known fixed CSS geometry when that element is not
 * mounted yet.
 */
import { useEffect, useRef } from 'react'
import * as THREE from 'three'
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js'

declare global {
	interface Window {
		playAnimation: ((name: string) => string) | undefined
		getAnimationList: (() => string[]) | undefined
	}
}

interface SoldierViewerProps {
	/** Show/hide the overlay. Animation loop keeps running while hidden. */
	visible: boolean
	/** glTF/GLB model URL. Served from the app's public root by default. */
	modelUrl?: string
	/** Default animation clip name, played on load and after one-shot clips. */
	idleAnimation?: string
}

const VIEWER_WIDTH = 120
const VIEWER_HEIGHT = 240

// Panel fallback geometry, mirroring ui/src/panel/Panel.module.css `.wrapper`:
// position: fixed; bottom: 100px; left: 50%; width: 360px.
const PANEL_WIDTH = 360
const PANEL_BOTTOM_GAP = 100

interface ViewerInternals {
	renderer: THREE.WebGLRenderer
	mixer: THREE.AnimationMixer | null
	animations: Record<string, THREE.AnimationClip>
	currentAction: THREE.AnimationAction | null
	clock: THREE.Clock
	frameId: number
}

export default function SoldierViewer({
	visible,
	modelUrl = '/soldier.glb',
	idleAnimation = 'IDLE',
}: SoldierViewerProps) {
	const containerRef = useRef<HTMLDivElement>(null)
	const internalsRef = useRef<ViewerInternals | null>(null)
	const idleRef = useRef(idleAnimation)
	idleRef.current = idleAnimation

	// Initialize the three.js scene once and expose the global animation API.
	useEffect(() => {
		const el = containerRef.current
		if (!el) return

		const scene = new THREE.Scene()
		const camera = new THREE.PerspectiveCamera(30, VIEWER_WIDTH / VIEWER_HEIGHT, 0.1, 100)
		camera.position.set(0, 0.9, 5)
		camera.lookAt(0, 0.9, 0)

		const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true })
		renderer.setSize(VIEWER_WIDTH, VIEWER_HEIGHT)
		renderer.setPixelRatio(window.devicePixelRatio)
		renderer.outputColorSpace = THREE.SRGBColorSpace
		el.appendChild(renderer.domElement)

		scene.add(new THREE.AmbientLight(0xffffff, 0.6))
		const dirLight = new THREE.DirectionalLight(0xffffff, 1.5)
		dirLight.position.set(3, 8, 5)
		scene.add(dirLight)

		const internals: ViewerInternals = {
			renderer,
			mixer: null,
			animations: {},
			currentAction: null,
			clock: new THREE.Clock(),
			frameId: 0,
		}
		internalsRef.current = internals

		const loader = new GLTFLoader()
		loader.load(
			modelUrl,
			(gltf) => {
				scene.add(gltf.scene)
				const mixer = new THREE.AnimationMixer(gltf.scene)
				internals.mixer = mixer
				gltf.animations.forEach((clip) => {
					internals.animations[clip.name] = clip
				})

				const idle = internals.animations[idleRef.current]
				if (idle) {
					internals.currentAction = mixer.clipAction(idle)
					internals.currentAction.play()
				}
			},
			undefined,
			() => {
				console.warn(`[SoldierViewer] failed to load ${modelUrl}, skipping 3D model render`)
			}
		)

		const animate = () => {
			internals.frameId = requestAnimationFrame(animate)
			const delta = internals.clock.getDelta()
			if (internals.mixer) internals.mixer.update(delta)
			renderer.render(scene, camera)
		}
		animate()

		window.playAnimation = (name: string) => {
			const animName = name.toUpperCase()
			const idleName = idleRef.current.toUpperCase()
			const { mixer, animations, currentAction } = internals
			if (!mixer || !animations[animName]) {
				return `❌ animation not found: ${name}. Available: ${Object.keys(animations).join(', ')}`
			}

			const newAction = mixer.clipAction(animations[animName])

			if (currentAction && currentAction !== newAction) {
				currentAction.fadeOut(0.3)
				newAction.reset().fadeIn(0.3).play()

				// Non-looping clips play once, then cross-fade back to idle.
				if (animName !== idleName && animName !== 'STAND') {
					newAction.setLoop(THREE.LoopOnce, 1)
					newAction.clampWhenFinished = true
					const onFinished = (e: { action: THREE.AnimationAction }) => {
						if (e.action !== newAction) return
						mixer.removeEventListener(
							'finished',
							onFinished as unknown as (event: THREE.Event) => void
						)
						newAction.fadeOut(0.3)
						const idleClip = animations[idleRef.current]
						if (idleClip) {
							const idleAction = mixer.clipAction(idleClip)
							idleAction.reset().fadeIn(0.3).play()
							internals.currentAction = idleAction
						}
					}
					mixer.addEventListener('finished', onFinished as unknown as (event: THREE.Event) => void)
				}
			} else {
				newAction.reset().play()
			}

			internals.currentAction = newAction
			return `✅ playing animation: ${animName}`
		}

		window.getAnimationList = () => Object.keys(internals.animations)

		return () => {
			cancelAnimationFrame(internals.frameId)
			renderer.dispose()
			if (el.contains(renderer.domElement)) {
				el.removeChild(renderer.domElement)
			}
			window.playAnimation = undefined
			window.getAnimationList = undefined
			internalsRef.current = null
		}
	}, [modelUrl])

	// Follow the OpenHumanPanel. A rAF loop tracks the panel through its
	// open/expand CSS transitions; reading getBoundingClientRect + writing
	// style each frame is cheap and stays in sync without polling intervals.
	useEffect(() => {
		const el = containerRef.current
		if (!el || !visible) return

		let frameId = 0
		const reposition = () => {
			frameId = requestAnimationFrame(reposition)

			const panel = document.querySelector<HTMLElement>('[data-openhuman-panel]')
			if (panel) {
				const rect = panel.getBoundingClientRect()
				el.style.left = `${rect.right - 10}px`
				el.style.top = `${rect.bottom - VIEWER_HEIGHT + 70}px`
			} else {
				// Fallback: derive position from the panel's fixed CSS geometry.
				const panelWidth = window.innerWidth < 480 ? window.innerWidth - 40 : PANEL_WIDTH
				const panelRight = window.innerWidth / 2 + panelWidth / 2
				const panelBottom = window.innerHeight - PANEL_BOTTOM_GAP
				el.style.left = `${panelRight - 10}px`
				el.style.top = `${panelBottom - VIEWER_HEIGHT + 70}px`
			}
		}
		reposition()

		return () => cancelAnimationFrame(frameId)
	}, [visible])

	return (
		<div
			ref={containerRef}
			style={{
				position: 'fixed',
				zIndex: 2147483643, // one above OpenHumanPanel's wrapper
				pointerEvents: 'none',
				visibility: visible ? 'visible' : 'hidden',
			}}
		/>
	)
}
