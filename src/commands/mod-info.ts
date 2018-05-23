import { RichEmbed, User } from 'discord.js';
import * as moment from 'moment';
import {
	Client,
	Command,
	CommandDecorators,
	Logger,
	logger,
	Message,
	Middleware
} from 'yamdbf';

import {
	customInvites,
	inviteCodes,
	joins,
	members,
	sequelize,
	CustomInviteInstance
} from '../sequelize';
import {
	CommandGroup,
	createEmbed,
	getInviteCounts,
	sendEmbed
} from '../utils/util';

const { resolve, expect } = Middleware;
const { using } = CommandDecorators;

export default class extends Command<Client> {
	@logger('Command') private readonly _logger: Logger;

	public constructor() {
		super({
			name: 'info',
			aliases: ['showinfo'],
			desc: 'Show info about a specific member',
			usage: '<prefix>info @user',
			info:
				'`' + '@user  The user for whom you want to see additional info.' + '`',
			callerPermissions: ['ADMINISTRATOR', 'MANAGE_CHANNELS', 'MANAGE_ROLES'],
			clientPermissions: ['MANAGE_GUILD'],
			group: CommandGroup.Admin,
			guildOnly: true
		});
	}

	@using(resolve('user: User'))
	@using(expect('user: User'))
	public async action(message: Message, [user]: [User]): Promise<any> {
		this._logger.log(
			`${message.guild.name} (${message.author.username}): ${message.content}`
		);

		let member = message.guild.members.get(user.id);

		if (!member) {
			message.channel.send('User is not part of your guild');
			return;
		}

		// TODO: Show current rank
		// let ranks = await settings.get('ranks');

		const invs = await inviteCodes.findAll({
			where: {
				guildId: member.guild.id,
				inviterId: member.id
			},
			order: [['uses', 'DESC']],
			raw: true
		});

		const customInvs = await customInvites.findAll({
			where: {
				guildId: member.guild.id,
				memberId: member.id
			},
			order: [['createdAt', 'DESC']],
			raw: true
		});

		const numNormal = invs.reduce((acc, inv) => acc + inv.uses, 0);
		const numCustom = customInvs
			.filter(i => !i.generated)
			.reduce((acc, inv) => acc + inv.amount, 0);

		const embed = createEmbed(this.client);
		embed.setTitle(member.user.username);

		const joinedAgo = moment(member.joinedAt).fromNow();
		embed.addField('Last joined', joinedAgo, true);
		embed.addField(
			'Invites',
			`${numNormal + numCustom} (${numCustom} bonus)`,
			true
		);

		const joinCount = Math.max(
			await joins.count({
				where: {
					guildId: member.guild.id,
					memberId: member.id
				}
			}),
			1
		);
		embed.addField('Joined', `${joinCount} times`, true);

		embed.addField('Created', moment(member.user.createdAt).fromNow());

		const js = await joins.findAll({
			attributes: ['createdAt'],
			where: {
				guildId: message.guild.id,
				memberId: user.id
			},
			order: [['createdAt', 'DESC']],
			include: [
				{
					attributes: ['inviterId'],
					model: inviteCodes,
					as: 'exactMatch',
					include: [
						{
							attributes: [],
							model: members,
							as: 'inviter'
						}
					]
				}
			],
			raw: true
		});

		if (js.length > 0) {
			const joinTimes: { [x: string]: { [x: string]: number } } = {};

			js.forEach((join: any) => {
				const text = moment(join.createdAt).fromNow();
				if (!joinTimes[text]) {
					joinTimes[text] = {};
				}

				const id = join['exactMatch.inviterId'];
				if (joinTimes[text][id]) {
					joinTimes[text][id]++;
				} else {
					joinTimes[text][id] = 1;
				}
			});

			const joinText = Object.keys(joinTimes)
				.map(time => {
					const joinTime = joinTimes[time];

					const total = Object.keys(joinTime).reduce(
						(acc, id) => acc + joinTime[id],
						0
					);
					const totalText = total > 1 ? `**${total}** times ` : 'once ';

					const invText = Object.keys(joinTime)
						.map(id => {
							const timesText =
								joinTime[id] > 1 ? ` (**${joinTime[id]}** times)` : '';
							return `<@${id}>${timesText}`;
						})
						.join(', ');
					return `${totalText}**${time}**, invited by: ${invText}`;
				})
				.join('\n');
			embed.addField('Joins', joinText);
		} else {
			embed.addField('Joins', 'unknown (this only works for new members)');
		}

		if (invs.length > 0) {
			let invText = '';
			invs.forEach(inv => {
				const reasonText = inv.reason ? `, reason: **${inv.reason}**` : '';
				invText += `**${inv.uses}** from **${inv.code}** - created **${moment(
					inv.createdAt
				).fromNow()}${reasonText}**\n`;
			});
			embed.addField('Regular invites', invText);
		} else {
			embed.addField(
				'Regular invites',
				'This member has not invited anyone so far'
			);
		}

		if (customInvs.length > 0) {
			let customInvText = '';
			customInvs.forEach(inv => {
				const reasonText = inv.reason
					? inv.generated
						? ', ' + this.formatGeneratedReason(inv)
						: `, reason: **${inv.reason}**`
					: '';
				const dateText = moment(inv.createdAt).fromNow();
				const creator = inv.creatorId ? inv.creatorId : message.guild.me.id;
				customInvText +=
					`**${inv.amount}** from <@${creator}> -` +
					` **${dateText}**${reasonText}\n`;
			});
			embed.addField('Bonus invites', customInvText);
		} else {
			embed.addField(
				'Bonus invites',
				'This member has received no bonuses so far'
			);
		}

		// invitedByText = 'Could not match inviter (multiple possibilities)';

		/*if (stillOnServerCount === 0 && trackedInviteCount === 0) {
				embed.addField('Invited people still on the server (since bot joined)',
				`User did not invite any members since this bot joined.`);
			} else {
				embed.addField('Invited people still on the server (since bot joined)',
				`**${stillOnServerCount}** still here out of **${trackedInviteCount}** invited members.`);
			}*/

		sendEmbed(message.channel, embed, message.author);
	}

	private formatGeneratedReason(inv: CustomInviteInstance) {
		if (inv.reason.startsWith('clear_invites')) {
			return '!clearinvites command';
		} else if (inv.reason.startsWith('fake:')) {
			const splits = inv.reason.split(':');
			return `Fake invites from <@${splits[1]}>`;
		}
		return '<Unknown reason>';
	}
}
