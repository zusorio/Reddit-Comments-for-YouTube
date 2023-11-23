import { cleanString } from '@/lib/tools/StringTools';
import { parseTimestamp } from '@/lib/tools/TimeTools';
import { SearchYouTubeRequest } from '@/lib/types/NetworkRequests';

interface YouTubeResult {
	videoId: string;
	title: string;
	channelName: string;
	channelId: string;
	videoLength: number;
	overlaps?: string[];
}

function findYouTubeMatch(
	results: YouTubeResult[],
	channelMatch: string | null,
	title: string,
	channelName: string,
	videoLength: number
): YouTubeResult | null {
	// filter by channel ID, or channel name if not mapped
	results = channelMatch
		? results.filter((r) => r.channelId === channelMatch)
		: results.filter(
				(r) => cleanString(r.channelName) === cleanString(channelName)
		  );

	// filter by episode number - return true if YouTube title has no episode number, or number matches (helpful for series like Jet Lag)
	const episodeMatchRegex = /(?:Episode|Ep|Part)[. ]*?(\d+)/i;
	const titleEpisodeMatch = title.match(episodeMatchRegex);
	if (titleEpisodeMatch) {
		results = results.filter((r) => {
			const resultEpisodeMatch = r.title.match(episodeMatchRegex);
			if (
				!resultEpisodeMatch ||
				titleEpisodeMatch[1] === resultEpisodeMatch[1]
			) {
				return true;
			}
		});
	}

	// check exact title
	const titleFilter = results.filter((r) => {
		if (cleanString(r.title) === cleanString(title)) {
			return r;
		}

		// check if title was modified with a suffix (e.g. "Cool Video" on Nebula and "Cool Video | Channel Name/Series" on YouTube)
		const splitTitle = title.split(/[|-–—]/).map((t) => cleanString(t));
		if (splitTitle.includes(cleanString(r.title))) {
			return r;
		}
	});

	if (titleFilter.length === 1) {
		return titleFilter[0];
	}

	// split title and remove common words for word by word comparison
	const commonWords = ['and', 'for', 'but', 'the'];
	const splitTitle = cleanString(title)
		.split(' ')
		.filter((w) => w.length > 2 && !commonWords.includes(w));

	results.forEach((r, i) => {
		const rTitle = cleanString(r.title).split(' ');
		results[i].overlaps = rTitle.filter((t) => splitTitle.includes(t));
	});

	// filter to only the results with the highest number of overlaps
	let highestOverlap = 0;
	results.forEach((r, i) => {
		if (!r?.overlaps?.length || r.overlaps.length < highestOverlap) {
			delete results[i];
			return;
		}
		highestOverlap = r.overlaps.length;
	});

	if (!highestOverlap) {
		return null;
	}

	// find the result with the closest video time, remove results where YouTube is more than 3 minutes longer than Nebula (to account for sponsors)
	let lowestDifference = Number.MAX_VALUE;
	results.forEach((r, i) => {
		const difference = videoLength - r.videoLength;
		const absoluteDifference = Math.abs(difference);
		if (absoluteDifference > lowestDifference || difference < -180) {
			delete results[i];
			return;
		}
		lowestDifference = absoluteDifference;
	});
	return results.find((r) => !!r) || null;
}

async function getYouTubeResults(channelName: string, title: string) {
	const response = await fetch(
		`https://www.youtube.com/results?search_query=${channelName} ${title}`
	);
	const textReponse = await response.text();

	const searchJson = JSON.parse(
		textReponse.split('>var ytInitialData = ')[1].split(';</script>')[0]
	);

	const results =
		searchJson.contents.twoColumnSearchResultsRenderer.primaryContents.sectionListRenderer.contents[0].itemSectionRenderer.contents
			.filter((r: any) => r.videoRenderer)
			.map(
				(r: any) =>
					<YouTubeResult>{
						videoId: r.videoRenderer.videoId,
						title: r.videoRenderer.title.runs[0].text,
						channelName: r.videoRenderer.longBylineText.runs[0].text,
						channelId:
							r.videoRenderer.longBylineText.runs[0].navigationEndpoint
								.browseEndpoint.browseId,
						videoLength: parseTimestamp(r.videoRenderer.lengthText.simpleText),
					}
			);

	return results;
}

async function matchNebulaChannel(channelId: string): Promise<string | null> {
	interface NebulaChannelMapping {
		nebulaChannel: string;
		youtubeChannel: string;
	}

	interface NebulaChannelMappingCache {
		mapping: NebulaChannelMapping[];
		lastUpdated: number;
	}

	const cachedChannels = await storage.getItem<NebulaChannelMappingCache>(
		'local:nebulaChannelMapping'
	);

	if (cachedChannels && Date.now() - cachedChannels.lastUpdated < 86400000) {
		const cachedChannelMatch = cachedChannels.mapping.find(
			(c) => c?.nebulaChannel === channelId
		);
		return cachedChannelMatch ? cachedChannelMatch.youtubeChannel : null;
	}

	const response = await fetch('https://talent.nebula.tv/creators/');
	const textReponse = await response.text();

	const channelEntries = [
		...textReponse.matchAll(
			/<div class="grid-item youtube-creator"[\s\S]*?<\/div><\/div><\/div><\/div>/gm
		),
	];

	const channels = channelEntries.map<NebulaChannelMapping | null>((c) => {
		const nebulaChannel = c[0].match(
			/(?<=<a href="https:\/\/talent.nebula.tv\/).*?(?=\/">)/
		);
		const youtubeChannel = c[0].match(/(?<=data-video=").*?(?=">)/);

		if (!nebulaChannel || !youtubeChannel) {
			return null;
		}

		return {
			nebulaChannel: nebulaChannel[0],
			youtubeChannel: youtubeChannel[0],
		};
	});

	const filteredChannels = channels.filter(
		(c): c is Exclude<typeof c, null> => c !== null
	);
	storage.setItem<NebulaChannelMappingCache>('local:nebulaChannelMapping', {
		mapping: filteredChannels,
		lastUpdated: Date.now(),
	});

	const channelMatch = filteredChannels.find(
		(c) => c?.nebulaChannel === channelId
	);

	return channelMatch ? channelMatch.youtubeChannel : null;
}

async function searchYouTube(r: SearchYouTubeRequest) {
	const [youtubeResults, channelMatch] = await Promise.all([
		getYouTubeResults(r.channelName, r.title),
		matchNebulaChannel(r.channelId),
	]);

	if ([youtubeResults, channelMatch].includes(undefined)) {
		return null;
	}

	const youtubeMatch = findYouTubeMatch(
		youtubeResults,
		channelMatch,
		r.title,
		r.channelName,
		r.videoLength
	);

	return youtubeMatch ? youtubeMatch.videoId : null;
}

export { searchYouTube };
