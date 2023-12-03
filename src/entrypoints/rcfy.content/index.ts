import { Site, getSite } from '@/lib/types/Site';
import ThreadSelector from './components/ThreadSelector.svelte';
import { SearchYouTubeRequest } from '@/lib/types/NetworkRequests';
import { sendMessage } from '@/lib/messaging';
import { siteStore, videoIdStore, youtubeIdStore } from './store';
import { SettingType, Settings, getSetting } from '@/lib/settings';
import './style.css';
import { SiteId } from '@/lib/constants';

export default defineContentScript({
	matches: ['*://*.youtube.com/*', '*://*.nebula.tv/*'],

	main(ctx: InstanceType<typeof ContentScriptContext>) {
		const site: Site = getSite(window.location.hostname);
		const ui: HTMLDivElement = document.createElement('div');

		setup(site, ui);

		browser.runtime.onMessage.addListener((message) => {
			if (message.hasUrlChanged) {
				ui.replaceChildren();
				setup(site, ui);
			}
		});

		ctx.onInvalidated(() => {
			ui.remove();
		});
	},
});

async function siteEnabled(id: SiteId) {
	switch (id) {
		case SiteId.YOUTUBE:
			return await getSetting(
				Settings.ENABLEYOUTUBE,
				SettingType.BOOLEAN
			).getValue();

		case SiteId.NEBULA:
			return await getSetting(
				Settings.ENABLENEBULA,
				SettingType.BOOLEAN
			).getValue();
	}
}

async function setup(site: Site, ui: HTMLDivElement) {
	siteStore.set(site);

	const isEnabled = await siteEnabled(site.id);
	if (!isEnabled) {
		return;
	}

	const videoId = getVideoId(site);
	if (!videoId) {
		return;
	}
	videoIdStore.set(videoId);

	const searchYouTubeEnabled =
		site.canMatchYouTube &&
		(await getSetting(Settings.MATCHTOYOUTUBE, SettingType.BOOLEAN).getValue());

	const [anchorElement, titleElement, usernameElement, videoElement] =
		await new Promise<any[]>((resolve) => {
			function res(elements: HTMLElement[]) {
				observer.disconnect();
				resolve(elements);
			}
			function checkElements() {
				const elements = [
					document.querySelector<HTMLElement>(site.anchorElement),
					document.querySelector<HTMLElement>(site.titleElement),
					document.querySelector<HTMLAnchorElement>(site.usernameElement),
					document.querySelector<HTMLVideoElement>(site.videoElement),
				];

				if (!searchYouTubeEnabled && elements[0]) {
					res(elements as HTMLElement[]);
				} else if (!elements.includes(null)) {
					if ((elements[3] as HTMLVideoElement).duration) {
						res(elements as HTMLElement[]);
					}
					elements[3]!.addEventListener(
						'loadedmetadata',
						function resolvePromise() {
							elements[3]?.removeEventListener(
								'loadedmetadata',
								resolvePromise
							);
							res(elements as HTMLElement[]);
						}
					);
				}
			}

			const observer = new MutationObserver(() => {
				checkElements();
			});

			observer.observe(document.body, {
				childList: true,
				subtree: true,
			});
		});

	anchorElement.insertAdjacentElement(site.anchorType, ui);

	new ThreadSelector({ target: ui });

	if (searchYouTubeEnabled) {
		searchYouTube(titleElement, usernameElement, videoElement);
	}
}

function getVideoId(site: Site) {
	const urlMatch = window.location.href.match(site.idRegex);
	return urlMatch ? urlMatch[0] : null;
}

async function searchYouTube(
	titleElement: HTMLElement,
	usernameElement: HTMLAnchorElement,
	videoElement: HTMLVideoElement
) {
	const searchYouTubeRequest: SearchYouTubeRequest = {
		title: titleElement.textContent!,
		channelName: usernameElement.textContent!,
		channelId: usernameElement.href.split('/').pop()!,
		videoLength: videoElement.duration,
	};

	const searchYouTubeResponse = await sendMessage(
		'searchYouTube',
		searchYouTubeRequest
	);

	if (!searchYouTubeResponse.success) {
		console.error('searchYouTube', searchYouTubeResponse.errorMessage);
	}

	youtubeIdStore.set(
		searchYouTubeResponse.success ? searchYouTubeResponse.value : null
	);
}