// Minimal command registry. Add a command = import its file + register it.
const commands = new Map()

export function register(command) {
  commands.set(command.name, command)
  return command
}

export function getCommand(name) {
  return commands.get(name)
}

export function listCommands() {
  return [...commands.values()].sort((a, b) => a.name.localeCompare(b.name))
}

// Fallback guidance when a command isn't recognized.
export function unknownCommandText(prefix) {
  return `Unknown command. Send *${prefix}help* for the list.`
}
