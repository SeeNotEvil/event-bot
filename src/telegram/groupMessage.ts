import type { MessageEntity } from 'grammy/types';

export type GroupMessageInput = {
  text: string;
  entities: MessageEntity[];
  replyToBot: boolean;
  botUsername: string;
};

type Replacement = {
  offset: number;
  length: number;
  value: string;
};

const INVOCATION_COMMANDS = new Set(['/iraida', '/ask']);
const NAME_ADDRESS = /^\s*мэй(?:[ \t]+мэй)?(?=$|[\s,.:;!?—–-])/iu;

function entityText(text: string, entity: MessageEntity): string {
  // Telegram entity offsets and JavaScript string indexes both use UTF-16 code units.
  return text.slice(entity.offset, entity.offset + entity.length);
}

function applyReplacements(text: string, replacements: Replacement[]): string {
  return [...replacements]
    .sort((left, right) => right.offset - left.offset)
    .reduce(
      (result, replacement) =>
        `${result.slice(0, replacement.offset)}${replacement.value}${result.slice(
          replacement.offset + replacement.length,
        )}`,
      text,
    );
}

export function extractGroupRequest(input: GroupMessageInput): string | null {
  const username = input.botUsername.toLocaleLowerCase('en-US');
  const expectedMentions = new Set([`@${username}`, '@meimei']);
  const mentionEntities = input.entities.filter(
    (entity) =>
      entity.type === 'mention' &&
      expectedMentions.has(entityText(input.text, entity).toLocaleLowerCase('en-US')),
  );
  const commandEntity = input.entities.find(
    (entity) => entity.type === 'bot_command' && entity.offset === 0,
  );
  const rawCommand = commandEntity ? entityText(input.text, commandEntity) : null;
  const [baseCommand = '', commandTarget] = (rawCommand ?? '').toLocaleLowerCase('en-US').split('@');
  const commandTargetsBot = commandTarget === username;
  const isInvocationCommand =
    INVOCATION_COMMANDS.has(baseCommand) &&
    (commandTarget === undefined || commandTargetsBot);
  // A name at the start is an address; mentions elsewhere can be ordinary discussion.
  const nameAddress = NAME_ADDRESS.exec(input.text);
  const isNameAddress = nameAddress !== null && !input.entities.some((entity) =>
    entity.offset < nameAddress[0].length &&
    ['code', 'pre', 'blockquote', 'expandable_blockquote', 'text_link', 'text_mention'].includes(entity.type),
  );

  if (
    !input.replyToBot &&
    mentionEntities.length === 0 &&
    !commandTargetsBot &&
    !isInvocationCommand &&
    !isNameAddress
  ) {
    return null;
  }

  const replacements: Replacement[] = mentionEntities.map((entity) => ({
    offset: entity.offset,
    length: entity.length,
    value: '',
  }));
  if (isNameAddress) {
    replacements.push({ offset: 0, length: nameAddress[0].length, value: '' });
  }

  if (commandEntity && rawCommand) {
    if (isInvocationCommand) {
      replacements.push({
        offset: commandEntity.offset,
        length: commandEntity.length,
        value: '',
      });
    } else if (commandTargetsBot) {
      replacements.push({
        offset: commandEntity.offset,
        length: commandEntity.length,
        value: baseCommand,
      });
    }
  }

  const request = applyReplacements(input.text, replacements)
    .trim()
    .replace(/\s+([,.:;!?])/gu, '$1')
    .replace(/^[,.:;!?—–-]+\s*/u, '')
    .trim();

  return request.length > 0 ? request : '/help';
}
