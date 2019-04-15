import { Guild, Member, Message } from 'eris';

import { IMClient } from '../../client';
import { SettingsObject } from '../../settings';
import {
	BotCommand,
	CommandGroup,
	InvitesCommand,
	ModerationCommand,
	MusicCommand
} from '../../types';
import { BooleanResolver } from '../resolvers';
import { Resolver, ResolverConstructor } from '../resolvers/Resolver';
import {
	CreateEmbedFunc,
	SendEmbedFunc,
	SendReplyFunc,
	ShowPaginatedFunc
} from '../services/Messaging';

export interface Arg {
	name: string;
	resolver: Resolver | ResolverConstructor;
	required?: boolean;
	rest?: boolean;
}

export interface Flag {
	name: string;
	resolver: Resolver | ResolverConstructor;
	short?: string;
}

export interface CommandOptions {
	name: BotCommand | InvitesCommand | ModerationCommand | MusicCommand;
	aliases: string[];
	args?: Arg[];
	flags?: Flag[];
	group?: CommandGroup;
	strict?: boolean;
	guildOnly: boolean;
	premiumOnly?: boolean;
}

export type TranslateFunc = (
	key: string,
	replacements?: { [key: string]: any }
) => string;

export type Context = {
	guild: Guild;
	me: Member;
	t: TranslateFunc;
	settings: SettingsObject;
	isPremium: boolean;
};

export abstract class Command {
	public client: IMClient;
	public resolvers: Resolver[];

	public name: BotCommand | InvitesCommand | ModerationCommand | MusicCommand;

	public aliases: string[];
	public args: Arg[];

	public flags: Flag[];
	public flagResolvers: Map<string, Resolver>;

	public usage: string;
	public group: CommandGroup;
	public strict?: boolean;
	public guildOnly: boolean;
	public premiumOnly?: boolean;

	protected createEmbed: CreateEmbedFunc;
	protected sendReply: SendReplyFunc;
	protected sendEmbed: SendEmbedFunc;
	protected showPaginated: ShowPaginatedFunc;

	public constructor(client: IMClient, props: CommandOptions) {
		this.client = client;
		this.name = props.name;
		this.aliases = props.aliases.map(a => a.toLowerCase());
		this.args = props.args ? props.args : [];
		this.flags = props.flags ? props.flags : [];
		this.group = props.group;
		this.strict = props.strict;
		this.guildOnly = props.guildOnly;
		this.premiumOnly = props.premiumOnly;

		this.usage = `{prefix}${this.name} `;

		this.flagResolvers = new Map();
		this.flags.forEach(flag => {
			const res =
				flag.resolver instanceof Resolver
					? flag.resolver
					: new flag.resolver(this.client);
			this.flagResolvers.set(flag.name, res);
			delete flag.resolver;

			const val = res instanceof BooleanResolver ? '' : '=value';
			const short = flag.short ? `-${flag.short}${val.replace('=', ' ')}|` : '';
			this.usage += `[${short}--${flag.name}${val}] `;
		});

		this.resolvers = [];
		this.args.forEach(arg => {
			if (arg.resolver instanceof Resolver) {
				this.resolvers.push(arg.resolver);
			} else {
				this.resolvers.push(new arg.resolver(this.client));
			}
			delete arg.resolver;

			this.usage += arg.required ? `<${arg.name}> ` : `[${arg.name}] `;
		});

		this.createEmbed = client.msg.createEmbed.bind(client.msg);
		this.sendReply = client.msg.sendReply.bind(client.msg);
		this.sendEmbed = client.msg.sendEmbed.bind(client.msg);
		this.showPaginated = client.msg.showPaginated.bind(client.msg);
	}

	public getInfo(context: Context) {
		let info = '';
		for (let i = 0; i < this.flags.length; i++) {
			const flag = this.flags[i];
			const help = this.flagResolvers.get(flag.name).getHelp(context);
			const descr = context.t(`cmd.${this.name}.self.flags.${flag.name}`);
			info +=
				`**--${flag.name}**\n${descr}\n` +
				(help ? `${help.substr(0, 800)}\n\n` : '\n');
		}
		for (let i = 0; i < this.args.length; i++) {
			const arg = this.args[i];
			const help = this.resolvers[i].getHelp(context);
			const descr = context.t(`cmd.${this.name}.self.args.${arg.name}`);
			info += `**<${arg.name}>**\n${descr}\n` + (help ? `${help}\n\n` : '\n');
		}
		return info;
	}

	public abstract action(
		message: Message,
		args: any[],
		flags: { [x: string]: any },
		context: Context
	): any;
}