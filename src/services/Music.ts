import AWS from 'aws-sdk';
import axios from 'axios';
import { Guild, Message, VoiceChannel, VoiceConnection } from 'eris';
import { Stream } from 'stream';
import { URLSearchParams } from 'url';

import { MusicCache } from '../cache/MusicCache';
import { IMClient } from '../client';
import { MusicQueue, MusicQueueItem } from '../types';

interface YoutubeVideo {
	id: string;
	videoId?: string;
	contentDetails: YoutubeVideoContentDetails;
	snippet: {
		channelTitle: string;
		description: string;
		thumbnails: {
			default: {
				height: number;
				url: string;
				width: number;
			};
		};
		title: string;
	};
}

interface YoutubeVideoContentDetails {
	duration: string;
}

const VOL_FADE_TIME = 1.5;

class MusicConnection {
	private service: MusicService;
	private musicQueueCache: MusicQueue;
	private voiceChannel: VoiceChannel;
	private connection: VoiceConnection;
	private nowPlayingMessage: Message;
	private volume: number = 1.0;
	private doPlayNext: boolean = true;
	private speaking: Set<string> = new Set();
	private doneCallback: () => void;

	public constructor(service: MusicService, musicQueueCache: MusicQueue) {
		this.service = service;
		this.musicQueueCache = musicQueueCache;
	}

	public switchChannel(voiceChannel: VoiceChannel) {
		this.voiceChannel = voiceChannel;
		this.connection.switchChannel(voiceChannel.id);
	}

	public isPlaying(): boolean {
		return this.connection && this.connection.playing;
	}

	public isPaused(): boolean {
		return this.connection && this.connection.paused;
	}

	public isConnected(): boolean {
		return !!this.connection;
	}

	public async play(item: MusicQueueItem, voiceChannel?: VoiceChannel) {
		console.log(item);

		if (voiceChannel) {
			await this.connect(voiceChannel);
		} else if (!this.connection) {
			if (this.voiceChannel) {
				await this.connect(this.voiceChannel);
			} else {
				throw new Error('Not connected and no voice channel specified');
			}
		}

		this.musicQueueCache.queue.push(item);
		if (!this.musicQueueCache.current) {
			this.playNext();
		}

		this.updateNowPlayingMessage();
	}

	public pause() {
		if (this.connection) {
			this.connection.pause();
		}
	}

	public resume() {
		if (this.connection) {
			this.connection.resume();
		}
	}

	public async rewind() {
		if (!this.connection) {
			if (this.voiceChannel) {
				await this.connect(this.voiceChannel);
			} else {
				throw new Error('Not connected to a voice channel');
			}
		}

		this.musicQueueCache.queue.unshift(this.musicQueueCache.current);
		this.playNext();
	}

	public async skip() {
		if (this.connection) {
			this.playNext();
		}
	}

	public setVolume(volume: number) {
		if (this.connection) {
			this.volume = volume;
			this.fadeVolumeTo(volume);
		}
	}

	public getNowPlaying() {
		return this.musicQueueCache.current;
	}

	public getQueue() {
		return this.musicQueueCache.queue;
	}

	public setNowPlayingMessage(message: Message) {
		this.nowPlayingMessage = message;
	}

	private startSpeakingTimeout: NodeJS.Timer;
	private stopSpeakingTimeout: NodeJS.Timer;
	public async connect(channel: VoiceChannel) {
		if (this.connection) {
			this.switchChannel(channel);
		} else {
			this.voiceChannel = channel;
			this.connection = await channel.join({ inlineVolume: true });
			this.connection.on('error', error => console.error(error));
			this.connection.on('speakingStart', userId => {
				if (this.speaking.size === 0) {
					if (this.stopSpeakingTimeout) {
						clearTimeout(this.stopSpeakingTimeout);
						this.stopSpeakingTimeout = null;
					} else {
						this.cancelFadeVolume();
						const func = () => {
							this.connection.setVolume(0.2 * this.volume);
							this.startSpeakingTimeout = null;
						};
						this.startSpeakingTimeout = setTimeout(func, 500);
					}
				}
				this.speaking.add(userId);
			});
			this.connection.on('speakingStop', userId => {
				this.speaking.delete(userId);
				if (this.speaking.size === 0) {
					if (this.startSpeakingTimeout) {
						clearTimeout(this.startSpeakingTimeout);
						this.startSpeakingTimeout = null;
					}
					const func = () => {
						this.stopSpeakingTimeout = null;
						this.fadeVolumeTo(this.volume);
					};
					this.stopSpeakingTimeout = setTimeout(func, 1000);
				}
			});
			this.connection.on('end', () => {
				console.log('STREAM END');
				this.musicQueueCache.current = null;

				if (this.doneCallback) {
					this.doneCallback();
					this.doneCallback = null;
				}

				if (this.doPlayNext) {
					this.playNext();
				}
			});
		}
	}

	private playNext() {
		const next = this.musicQueueCache.queue.shift();
		if (next) {
			if (this.connection.playing) {
				this.doPlayNext = false;
				this.connection.stopPlaying();
			}

			this.service.polly.synthesizeSpeech(
				{
					Text: 'Now playing: ' + next.title,
					LanguageCode: 'en-US',
					OutputFormat: 'ogg_vorbis',
					VoiceId: 'Joanna'
				},
				(err, data) => {
					if (err) {
						console.error(err);
						this.doneCallback();
						return;
					}

					this.doneCallback = async () => {
						const stream = await next.getStream();

						this.musicQueueCache.current = next;
						this.connection.play(stream, {
							inlineVolume: true
						});
						this.updateNowPlayingMessage();

						this.doPlayNext = true;
					};

					const bufferStream = new Stream.PassThrough();
					bufferStream.end(data.AudioStream);

					this.connection.play(bufferStream);
				}
			);
		}
	}

	public async seek(time: number) {
		this.doPlayNext = false;

		const current = this.musicQueueCache.current;
		const stream = await current.getStream();

		this.connection.stopPlaying();
		this.connection.play(stream, {
			inlineVolume: true,
			inputArgs: [`-ss`, `${time}`]
		});
		this.musicQueueCache.current = current;
		this.doPlayNext = true;
	}

	private fadeTimeouts: NodeJS.Timer[] = [];
	private fadeVolumeTo(newVolume: number) {
		this.cancelFadeVolume();

		const startVol = this.connection.volume;
		const diff = newVolume - startVol;
		const step = diff / (VOL_FADE_TIME * 10);
		for (let i = 0; i < VOL_FADE_TIME * 10; i++) {
			const newVol = Math.max(0, Math.min(startVol + i * step, 2));
			this.fadeTimeouts.push(
				setTimeout(() => this.connection.setVolume(newVol), i * 100)
			);
		}
	}

	private cancelFadeVolume() {
		this.fadeTimeouts.forEach(t => clearTimeout(t));
		this.fadeTimeouts = [];
	}

	private updateNowPlayingMessage() {
		if (this.nowPlayingMessage) {
			this.nowPlayingMessage.edit({
				embed: this.service.createPlayingEmbed(null)
			});
		}
	}

	public disconnect() {
		if (this.connection) {
			this.connection.stopPlaying();
			this.voiceChannel.leave();
			this.connection = null;
		}
	}
}

export class MusicService {
	private client: IMClient = null;
	private cache: MusicCache;
	private musicConnections: Map<string, MusicConnection>;
	public polly: AWS.Polly;

	public constructor(client: IMClient) {
		this.client = client;
		this.cache = client.cache.music;
		this.musicConnections = new Map();
		this.polly = new AWS.Polly({
			signatureVersion: 'v4',
			region: 'us-east-1',
			credentials: client.config.bot.aws
		});
	}

	public async getMusicConnection(guild: Guild) {
		let conn = this.musicConnections.get(guild.id);
		if (!conn) {
			conn = new MusicConnection(this, await this.cache.get(guild.id));
			this.musicConnections.set(guild.id, conn);
		}
		return conn;
	}

	public createPlayingEmbed(item: MusicQueueItem) {
		if (!item) {
			return this.client.msg.createEmbed({
				author: { name: 'InvMan Music', icon_url: this.client.user.avatarURL },
				color: 255, // blue
				title: 'Not playing',
				fields: []
			});
		}

		return this.client.msg.createEmbed({
			author: {
				name: `${item.user.username}#${item.user.discriminator}`,
				icon_url: item.user.avatarURL
			},
			image: { url: item.imageURL },
			color: 255, // blue
			title: item.title,
			fields: item.extras
		});
	}

	public async searchYoutube(searchTerm: string, maxResults?: number) {
		const params: URLSearchParams = new URLSearchParams();
		params.set('key', this.client.config.bot.youtubeApiKey);
		params.set('type', 'video');
		// params.set('videoEmbeddable', "true");
		// params.set('videoSyndicated', "true");
		params.set('videoCategoryId', '10'); // only music videos
		params.set('maxResults', (maxResults || 10).toString());
		params.set('part', 'id');
		params.set('fields', 'items(id(videoId))');
		params.set('q', searchTerm);

		const { data } = await axios(
			`https://www.googleapis.com/youtube/v3/search?${params}`
		);

		return this.getVideoDetails(
			data.items.map((item: any) => item.id.videoId).join(',')
		);
	}

	private async getVideoDetails(
		idList: string
	): Promise<{ items: Array<YoutubeVideo> }> {
		const params: URLSearchParams = new URLSearchParams();
		params.set('key', this.client.config.bot.youtubeApiKey);
		params.set('id', idList);
		params.set('part', 'contentDetails,snippet');
		params.set(
			'fields',
			'items(id,snippet(title,description,thumbnails(default),channelTitle),contentDetails(duration))'
		);

		const { data } = await axios(
			`https://www.googleapis.com/youtube/v3/videos?${params}`
		);

		return data;
	}
}