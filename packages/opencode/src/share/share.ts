import { Session } from "../session"
import { Log } from "../util/log"
import path from "path"
import fs from "fs/promises"

export namespace Share {
  const log = Log.create({ service: "share" })
  
  type SessionTree = { session: any, messages: any[], children: SessionTree[] }

  export async function sync(_key: string, _content: any) {
    // Local sharing doesn't need cloud sync - no-op
    // This preserves the API but does nothing
    return
  }

  export function init() {
    // Local sharing doesn't need to sync storage events - no-op
    // This preserves the API but does nothing
    return
  }

  export async function create(sessionID: string, options?: { includeChildSessions?: boolean }) {
    // Create local HTML file instead of cloud share
    const session = await Session.get(sessionID)
    const messages = await Session.messages(sessionID)
    
    // Recursively collect all child sessions with their full hierarchy
    const childSessions: SessionTree[] = []
    const includeChildren = options?.includeChildSessions ?? true
    
    // Recursive function to collect the full session tree
    async function collectSessionTree(parentID: string): Promise<SessionTree[]> {
      const directChildren = await Session.children(parentID)
      const result: SessionTree[] = []
      
      for (const child of directChildren) {
        try {
          const childMessages = await Session.messages(child.id)
          const grandChildren = await collectSessionTree(child.id) // RECURSION!
          result.push({ 
            session: child, 
            messages: childMessages,
            children: grandChildren
          })
        } catch (e) {
          log.warn("failed to load child session", { childId: child.id, error: e })
        }
      }
      
      return result
    }
    
    if (includeChildren) {
      childSessions.push(...await collectSessionTree(sessionID))
    }
    
    // Helper function to count all subtasks recursively
    function countAllSubtasks(subtasks: SessionTree[]): number {
      let count = subtasks.length
      for (const subtask of subtasks) {
        count += countAllSubtasks(subtask.children)
      }
      return count
    }
    
    const totalSubtasks = countAllSubtasks(childSessions)
    const markdown = generateConversationMarkdown(session, messages, childSessions)
    const html = generateConversationHTML(session, messages, childSessions, markdown, totalSubtasks)
    const suffix = totalSubtasks > 0 ? `-with-${totalSubtasks}-tasks` : ''
    const fileName = `opencode-session-${sessionID.slice(-8)}${suffix}.html`
    
    // Create export directory if it doesn't exist
    const exportDir = '/tmp/opencode'
    await fs.mkdir(exportDir, { recursive: true })
    const filePath = path.join(exportDir, fileName)
    
    await fs.writeFile(filePath, html)
    
    log.info("created local share", {
      sessionID,
      filePath,
      childSessions: childSessions.length,
    })
    
    // Return same format as cloud sharing for compatibility
    return {
      url: `file://${filePath.replace(/\\/g, '/')}`, // Normalize path separators for file URLs
      secret: "local-only"
    }
  }

  export async function remove(id: string) {
    // Remove local HTML files instead of cloud share
    // Try to find files matching the pattern since we don't know the exact filename
    const baseFileName = `opencode-session-${id.slice(-8)}`
    const exportDir = '/tmp/opencode'
    
    let removed = false
    
    try {
      const files = await fs.readdir(exportDir)
      const matchingFiles = files.filter(file => 
        file.startsWith(baseFileName) && file.endsWith('.html')
      )
      
      for (const fileName of matchingFiles) {
        const filePath = path.join(exportDir, fileName)
        try {
          await fs.unlink(filePath)
          log.info("removed local share", { filePath })
          removed = true
        } catch (e) {
          log.warn("failed to remove local share file", { filePath, error: e })
        }
      }
      
      if (!removed) {
        log.warn("no matching share files found", { baseFileName })
      }
    } catch (e) {
      log.warn("failed to list directory for cleanup", { error: e })
    }
    
    return { success: true }
  }

  function generateConversationHTML(session: any, messages: any[], childSessions: SessionTree[] = [], markdown: string, totalSubtasks: number = 0): string {
    const title = session.title || "OpenCode Session"
    
    // Recursive function to render subtask tree
    function renderSubtaskTree(subtasks: SessionTree[], depth: number = 0, cutoffTime?: number): string {
      if (subtasks.length === 0) return ''
      
      const indentClass = depth > 0 ? `ml-${Math.min(depth * 4, 16)}` : 'ml-8'
      const borderColor = depth % 2 === 0 ? 'border-blue-200' : 'border-purple-200'
      
      return `
        <div class="mt-6 ${indentClass}">
          ${subtasks.map((child, _taskIndex) => `
            <div class="border-l-3 ${borderColor} pl-6 mb-4" x-data="{ open: false }">
              <div class="bg-indigo-50 border border-indigo-200 rounded-lg p-4">
                <button @click="open = !open" class="w-full text-left">
                  <div class="flex items-center justify-between">
                    <div>
                      <div class="font-semibold text-sm text-indigo-900">
                        ${'  '.repeat(depth)}Subtask: ${escapeHtml(child.session.title || 'Untitled')}
                      </div>
                      <div class="text-xs text-indigo-700 mt-1">
                        <span class="font-mono">${child.session.id}</span> · ${child.messages.length} messages
                        ${child.children.length > 0 ? ` · ${child.children.length} subtasks` : ''}
                      </div>
                    </div>
                    <svg class="w-4 h-4 text-indigo-600 transition-transform duration-200" :class="open ? 'rotate-180' : ''" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M19 9l-7 7-7-7"></path>
                    </svg>
                  </div>
                </button>
                
                <div x-show="open" x-transition:enter="transition ease-out duration-200" x-transition:enter-start="opacity-0" x-transition:enter-end="opacity-100" class="mt-4 space-y-4">
                  ${renderSubtaskMessages(child.messages, depth, cutoffTime)}
                  ${renderSubtaskTree(child.children, depth + 1, cutoffTime)}
                </div>
              </div>
            </div>
          `).join('')}
        </div>
      `
    }
    
    // Function to render messages within a subtask
    function renderSubtaskMessages(taskMessages: any[], _depth: number, cutoffTime?: number): string {
      // Filter messages based on cutoff time for timeline view
      const filteredMessages = cutoffTime 
        ? taskMessages.filter(msg => !msg.metadata?.time?.created || msg.metadata.time.created <= cutoffTime)
        : taskMessages
      
      return filteredMessages.map((taskMsg) => {
        const taskModelInfo = taskMsg.metadata?.assistant?.modelID ? `${taskMsg.metadata.assistant.modelID.split('/').pop() || taskMsg.metadata.assistant.modelID}` : ''
        const taskTimestamp = taskMsg.metadata?.time?.created ? new Date(taskMsg.metadata.time.created).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : ''
        const taskMessageText = extractMessageText(taskMsg.parts || [])
        
        return `
          <div class="${taskMsg.role === 'user' ? 'flex justify-end' : ''}">
            <div class="${taskMsg.role === 'user' ? 'max-w-lg' : 'w-full'}">
              <div class="${taskMsg.role === 'user' ? 'border-r-3 border-teal-400 bg-teal-50' : 'border-l-3 border-yellow-400 bg-yellow-50'} rounded px-4 py-3 relative">
                <button 
                  onclick="copyToClipboard('${escapeHtml(taskMessageText).replace(/'/g, "\\\\'")}', this)" 
                  class="absolute top-1 right-1 p-1 text-gray-400 hover:text-gray-600 hover:bg-white/50 rounded transition-colors duration-200 opacity-60 hover:opacity-100"
                  title="Copy message"
                >
                  <svg class="w-2.5 h-2.5" fill="currentColor" viewBox="0 0 24 24">
                    <path d="M16 1H4c-1.1 0-2 .9-2 2v14h2V3h12V1zm3 4H8c-1.1 0-2 .9-2 2v14c0 1.1.9 2 2 2h11c1.1 0 2-.9 2-2V7c0-1.1-.9-2-2-2zm0 16H8V7h11v14z"/>
                  </svg>
                </button>
                <div class="text-sm text-gray-900 pr-8">
                  ${(taskMsg.parts || []).map((part: any) => formatMessagePart(part, taskMsg.role)).join('')}
                </div>
                ${(taskModelInfo || taskTimestamp) && taskMsg.role === 'assistant' ? `
                  <div class="mt-2 text-xs text-gray-500 flex items-center gap-2">
                    ${taskModelInfo ? `<span>${taskModelInfo}</span>` : ''}
                    ${taskModelInfo && taskTimestamp ? `<span>·</span>` : ''}
                    ${taskTimestamp ? `<span>${taskTimestamp}</span>` : ''}
                  </div>
                ` : ''}
                ${taskTimestamp && taskMsg.role === 'user' ? `
                  <div class="mt-2 text-xs text-gray-500 text-right">
                    ${taskTimestamp}
                  </div>
                ` : ''}
              </div>
            </div>
          </div>
        `
      }).join('')
    }
    
    return `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>${escapeHtml(title)}</title>
    <meta name="description" content="OpenCode AI Conversation Export">
    <script src="https://cdn.tailwindcss.com"></script>
    <script src="https://unpkg.com/alpinejs@3.x.x/dist/cdn.min.js" defer></script>
    <script>
        function copyToClipboard(text, button) {
            navigator.clipboard.writeText(text).then(() => {
                const originalIcon = button.innerHTML;
                button.innerHTML = '<svg class="w-3 h-3" fill="currentColor" viewBox="0 0 24 24"><path d="M9 16.17L4.83 12l-1.42 1.41L9 19 21 7l-1.41-1.41z"/></svg>';
                button.classList.add('text-green-600');
                setTimeout(() => {
                    button.innerHTML = originalIcon;
                    button.classList.remove('text-green-600');
                }, 1500);
            }).catch(() => {
                // Fallback for older browsers
                const textArea = document.createElement('textarea');
                textArea.value = text;
                document.body.appendChild(textArea);
                textArea.select();
                document.execCommand('copy');
                document.body.removeChild(textArea);
            });
        }

        function copyConversationAsMarkdown(button) {
            const markdown = generateConversationMarkdown();
            copyToClipboard(markdown, button);
        }

        function generateConversationMarkdown() {
            return window.conversationMarkdown || '# Conversation Export\\n\\nMarkdown generation failed.';
        }

        // Set the markdown content
        window.conversationMarkdown = ${JSON.stringify(markdown)};
    </script>
    <style>
        body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', 'Roboto', 'Helvetica', 'Arial', sans-serif; }
        .font-mono { font-family: 'Menlo', 'Monaco', 'Courier New', monospace; }
        .chat-container { max-width: 48rem; margin: 0 auto; }
        .message-content { line-height: 1.6; }
        .border-l-3 { border-left-width: 3px; }
        .border-r-3 { border-right-width: 3px; }
        pre { white-space: pre-wrap; word-break: break-word; }
        ::-webkit-scrollbar { width: 8px; height: 8px; }
        ::-webkit-scrollbar-track { background: #f9fafb; }
        ::-webkit-scrollbar-thumb { background: #e5e7eb; border-radius: 4px; }
        ::-webkit-scrollbar-thumb:hover { background: #d1d5db; }
    </style>
</head>
<body class="bg-white text-gray-900">
    <div class="chat-container px-4 py-12">
        <!-- Header -->
        <div class="mb-12 text-center">
            <h1 class="text-2xl font-semibold mb-2">${escapeHtml(title)}</h1>
            <div class="text-sm text-gray-600 space-y-1">
                <div>Session ID: <span class="font-mono text-xs">${escapeHtml(session.id || 'Unknown')}</span></div>
                <div>${session.time?.created ? new Date(session.time.created).toLocaleDateString() : ''} · ${messages.length} messages · ${totalSubtasks} subtasks</div>
            </div>
            <div class="mt-4">
                <button 
                    onclick="copyConversationAsMarkdown(this)" 
                    class="inline-flex items-center gap-2 px-4 py-2 text-sm text-gray-600 hover:text-gray-900 hover:bg-gray-100 border border-gray-300 rounded-lg transition-colors duration-200"
                    title="Copy entire conversation as Markdown"
                >
                    <svg class="w-4 h-4" fill="currentColor" viewBox="0 0 24 24">
                        <path d="M16 1H4c-1.1 0-2 .9-2 2v14h2V3h12V1zm3 4H8c-1.1 0-2 .9-2 2v14c0 1.1.9 2 2 2h11c1.1 0 2-.9 2-2V7c0-1.1-.9-2-2-2zm0 16H8V7h11v14z"/>
                    </svg>
                    Copy as Markdown
                </button>
            </div>
        </div>

        <!-- Messages -->
        <div class="space-y-6">
            ${messages.map((message, messageIndex) => {
              const modelInfo = message.metadata?.assistant?.modelID ? `${message.metadata.assistant.modelID.split('/').pop() || message.metadata.assistant.modelID}` : '';
              const timestamp = message.metadata?.time?.created ? new Date(message.metadata.time.created).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : '';
              const messageText = extractMessageText(message.parts || []);
              
              let messageHtml = `
                <div class="${message.role === 'user' ? 'flex justify-end' : ''}">
                    <div class="${message.role === 'user' ? 'max-w-2xl' : 'w-full'}">
                        <div class="${message.role === 'user' ? 'border-r-4 border-teal-400 bg-teal-50' : 'border-l-4 border-blue-400 bg-blue-50'} rounded-lg px-5 py-4 relative group">
                            <button 
                                onclick="copyToClipboard('${escapeHtml(messageText).replace(/'/g, "\\'")}', this)" 
                                class="absolute top-2 right-2 p-1.5 text-gray-400 hover:text-gray-600 hover:bg-white/50 rounded transition-colors duration-200 opacity-60 hover:opacity-100"
                                title="Copy message"
                            >
                                <svg class="w-3 h-3" fill="currentColor" viewBox="0 0 24 24">
                                    <path d="M16 1H4c-1.1 0-2 .9-2 2v14h2V3h12V1zm3 4H8c-1.1 0-2 .9-2 2v14c0 1.1.9 2 2 2h11c1.1 0 2-.9 2-2V7c0-1.1-.9-2-2-2zm0 16H8V7h11v14z"/>
                                </svg>
                            </button>
                            <div class="message-content text-gray-900 pr-10">
                                ${(message.parts || []).map((part: any) => formatMessagePart(part, message.role)).join('')}
                            </div>
                            ${(modelInfo || timestamp) && message.role === 'assistant' ? `
                                <div class="mt-3 text-xs text-gray-500 flex items-center gap-2">
                                    ${modelInfo ? `<span>${modelInfo}</span>` : ''}
                                    ${modelInfo && timestamp ? `<span>·</span>` : ''}
                                    ${timestamp ? `<span>${timestamp}</span>` : ''}
                                </div>
                            ` : ''}
                            ${timestamp && message.role === 'user' ? `
                                <div class="mt-3 text-xs text-gray-500 text-right">
                                    ${timestamp}
                                </div>
                            ` : ''}
                        </div>
                    </div>
                </div>
              `
              
              // Check if this message contains TaskTool or AgentTool calls and add inline subtask sessions
              const subtaskToolParts = (message.parts || []).filter((part: any) => 
                part.type === 'tool-invocation' && 
                (part.toolInvocation?.toolName === 'task' || part.toolInvocation?.toolName === 'agent')
              )
              
              if (subtaskToolParts.length > 0 && childSessions.length > 0) {
                // Add recursive subtask sessions inline after this message
                // Use the next message's timestamp as cutoff, or end of conversation if this is the last message
                const nextMessage = messages[messageIndex + 1]
                const cutoffTime = nextMessage?.metadata?.time?.created || Date.now()
                messageHtml += renderSubtaskTree(childSessions, 0, cutoffTime)
              }
              
              return messageHtml
            }).join('')}
        </div>
        
        <!-- Footer -->
        <div class="mt-16 pt-8 border-t border-gray-200 text-center text-sm text-gray-500">
            <div>OpenCode Conversation Export · ${new Date().toLocaleDateString()}</div>
        </div>
    </div>
</body>
</html>`
  }

  function formatMessagePart(part: any, _messageRole: string = 'assistant'): string {
    
    switch (part.type) {
      case 'text':
        return `<div class="whitespace-pre-wrap">${escapeHtml(part.text)}</div>`
      
      case 'tool-invocation':
        const tool = part.toolInvocation
        if (tool.state === 'call') {
          return `
            <div class="mt-3 bg-white border border-gray-200 rounded-lg p-4 shadow-sm">
              <div class="flex items-center gap-3 mb-3">
                <div class="w-8 h-8 bg-blue-100 rounded-lg flex items-center justify-center">
                  <svg class="w-4 h-4 text-blue-600" fill="currentColor" viewBox="0 0 24 24">
                    <path d="M19 7h-3V6a4 4 0 0 0-8 0v1H5a1 1 0 0 0-1 1v11a3 3 0 0 0 3 3h10a3 3 0 0 0 3-3V8a1 1 0 0 0-1-1zM10 6a2 2 0 0 1 4 0v1h-4V6zm6 16H8a1 1 0 0 1-1-1V9h10v12a1 1 0 0 1-1 1z"/>
                  </svg>
                </div>
                <div class="flex-1">
                  <div class="font-semibold text-gray-900">${escapeHtml(tool.toolName)}</div>
                  <div class="text-sm text-blue-600">Tool Called</div>
                </div>
              </div>
              <div class="bg-gray-50 rounded-lg p-3">
                <div class="text-xs text-gray-500 mb-3 font-medium">Parameters:</div>
                ${formatToolArguments(tool.args)}
              </div>
            </div>
          `
        } else if (tool.state === 'result') {
          return `
            <div class="mt-3 bg-white border border-gray-200 rounded-lg p-4 shadow-sm">
              <div class="flex items-center gap-3 mb-3">
                <div class="w-8 h-8 bg-green-100 rounded-lg flex items-center justify-center">
                  <svg class="w-4 h-4 text-green-600" fill="currentColor" viewBox="0 0 24 24">
                    <path d="M9 16.17L4.83 12l-1.42 1.41L9 19 21 7l-1.41-1.41z"/>
                  </svg>
                </div>
                <div class="flex-1">
                  <div class="font-semibold text-gray-900">${escapeHtml(tool.toolName)}</div>
                  <div class="text-sm text-green-600">Tool Result</div>
                </div>
              </div>
              ${tool.args ? `
                <div class="bg-gray-50 rounded-lg p-3 mb-3">
                  <div class="text-xs text-gray-500 mb-3 font-medium">Parameters:</div>
                  ${formatToolArguments(tool.args)}
                </div>
              ` : ''}
              <div class="bg-gray-50 rounded-lg p-3">
                <div class="text-xs text-gray-500 mb-2 font-medium">Output:</div>
                <div class="text-sm font-mono whitespace-pre-wrap max-h-80 overflow-y-auto text-gray-700 border border-gray-200 rounded bg-white p-3">${escapeHtml(tool.result)}</div>
              </div>
            </div>
          `
        }
        return `
          <div class="mt-3 bg-white border border-gray-200 rounded-lg p-4 shadow-sm">
            <div class="flex items-center gap-3">
              <div class="w-8 h-8 bg-gray-100 rounded-lg flex items-center justify-center">
                <svg class="w-4 h-4 text-gray-600" fill="currentColor" viewBox="0 0 24 24">
                  <path d="M19 7h-3V6a4 4 0 0 0-8 0v1H5a1 1 0 0 0-1 1v11a3 3 0 0 0 3 3h10a3 3 0 0 0 3-3V8a1 1 0 0 0-1-1zM10 6a2 2 0 0 1 4 0v1h-4V6zm6 16H8a1 1 0 0 1-1-1V9h10v12a1 1 0 0 1-1 1z"/>
                </svg>
              </div>
              <div class="flex-1">
                <div class="font-semibold text-gray-900">${escapeHtml(tool.toolName)}</div>
                <div class="text-sm text-gray-600">Tool</div>
              </div>
            </div>
          </div>
        `
      
      case 'file':
        return `
          <div class="mt-3 bg-white border border-gray-200 rounded-lg p-3 shadow-sm">
            <div class="flex items-center gap-3">
              <div class="w-8 h-8 bg-purple-100 rounded-lg flex items-center justify-center">
                <svg class="w-4 h-4 text-purple-600" fill="currentColor" viewBox="0 0 24 24">
                  <path d="M14,2H6A2,2 0 0,0 4,4V20A2,2 0 0,0 6,22H18A2,2 0 0,0 20,20V8L14,2M18,20H6V4H13V9H18V20Z"/>
                </svg>
              </div>
              <div class="flex-1 min-w-0">
                <div class="font-medium text-gray-900">File Attachment</div>
                <div class="text-sm text-gray-600 truncate">${escapeHtml(part.filename || part.url)}</div>
              </div>
            </div>
          </div>
        `
      
      case 'reasoning':
        return `
          <div class="mt-3 bg-purple-50 border border-purple-200 rounded-lg p-4">
            <div class="flex items-start gap-3">
              <div class="w-6 h-6 bg-purple-100 rounded-lg flex items-center justify-center flex-shrink-0 mt-0.5">
                <svg class="w-4 h-4 text-purple-600" fill="currentColor" viewBox="0 0 24 24">
                  <path d="M9,2A7,7 0 0,0 2,9A7,7 0 0,0 9,16A7,7 0 0,0 16,9A7,7 0 0,0 9,2M9,14A5,5 0 0,1 4,9A5,5 0 0,1 9,4A5,5 0 0,1 14,9A5,5 0 0,1 9,14M9,6A3,3 0 0,0 6,9A3,3 0 0,0 9,12A3,3 0 0,0 12,9A3,3 0 0,0 9,6Z"/>
                </svg>
              </div>
              <div class="flex-1 italic text-purple-800 leading-relaxed">${escapeHtml(part.text)}</div>
            </div>
          </div>
        `
      
      case 'step-start':
        // Hide step-start parts as they're internal
        return ''
      
      default:
        return `
          <div class="mt-3 bg-gray-50 border border-gray-200 rounded-lg p-3">
            <div class="text-sm font-mono text-gray-600">${escapeHtml(JSON.stringify(part))}</div>
          </div>
        `
    }
  }

  function formatToolArguments(args: any): string {
    if (!args || typeof args !== 'object') {
      return `<div class="text-sm text-gray-600">${escapeHtml(String(args))}</div>`
    }

    const entries = Object.entries(args)
    if (entries.length === 0) {
      return `<div class="text-sm text-gray-500 italic">No parameters</div>`
    }

    return entries.map(([key, value]) => {
      const formattedValue = formatArgumentValue(value)
      return `
        <div class="mb-2 last:mb-0">
          <div class="flex items-start gap-2">
            <span class="text-xs font-mono font-semibold text-blue-700 bg-blue-200 px-2 py-1 rounded">${escapeHtml(key)}</span>
            <div class="flex-1 min-w-0">${formattedValue}</div>
          </div>
        </div>
      `
    }).join('')
  }

  function formatArgumentValue(value: any): string {
    if (value === null) return `<span class="text-gray-500 italic">null</span>`
    if (value === undefined) return `<span class="text-gray-500 italic">undefined</span>`
    if (typeof value === 'boolean') return `<span class="text-purple-600 font-medium">${value}</span>`
    if (typeof value === 'number') return `<span class="text-green-600 font-medium">${value}</span>`
    if (typeof value === 'string') {
      if (value.length > 100) {
        return `
          <div class="bg-white border border-gray-200 rounded p-2 text-sm">
            <div class="whitespace-pre-wrap text-gray-700">${escapeHtml(value)}</div>
          </div>
        `
      }
      return `<span class="text-gray-800">"${escapeHtml(value)}"</span>`
    }
    if (Array.isArray(value)) {
      if (value.length === 0) return `<span class="text-gray-500">[]</span>`
      if (value.length <= 3 && value.every(v => typeof v === 'string' || typeof v === 'number')) {
        return `<span class="text-gray-700">[${value.map(v => typeof v === 'string' ? `"${escapeHtml(v)}"` : v).join(', ')}]</span>`
      }
      return `
        <div class="bg-white border border-gray-200 rounded p-2">
          <div class="text-xs text-gray-500 mb-1">Array (${value.length} items):</div>
          <pre class="text-xs font-mono text-gray-700 overflow-x-auto">${escapeHtml(JSON.stringify(value, null, 2))}</pre>
        </div>
      `
    }
    if (typeof value === 'object') {
      return `
        <div class="bg-white border border-gray-200 rounded p-2">
          <div class="text-xs text-gray-500 mb-1">Object:</div>
          <pre class="text-xs font-mono text-gray-700 overflow-x-auto">${escapeHtml(JSON.stringify(value, null, 2))}</pre>
        </div>
      `
    }
    return `<span class="text-gray-600">${escapeHtml(String(value))}</span>`
  }

  function generateConversationMarkdown(session: any, messages: any[], childSessions: SessionTree[] = []): string {
    const title = session.title || "OpenCode Session"
    const date = session.time?.created ? new Date(session.time.created).toLocaleDateString() : ''
    const sessionId = session.id || 'Unknown'
    
    let markdown = `# ${title}\n\n`
    markdown += `**Session ID:** ${sessionId}\n`
    markdown += `**Date:** ${date}\n`
    markdown += `**Messages:** ${messages.length}\n`
    markdown += `**Subtasks:** ${childSessions.length}\n\n`
    markdown += `---\n\n`
    
    // Recursive function to render subtask markdown
    function renderSubtaskMarkdown(subtasks: SessionTree[], depth: number = 0): string {
      if (subtasks.length === 0) return ''
      
      let result = ''
      
      subtasks.forEach((child, _taskIndex) => {
        const headingLevel = Math.min(depth + 3, 6) // Max heading level is 6
        const heading = '#'.repeat(headingLevel)
        
        result += `${heading} Subtask: ${child.session.title || 'Untitled'}\n\n`
        result += `**Session ID:** ${child.session.id}\n`
        result += `**Messages:** ${child.messages.length}\n`
        if (child.children.length > 0) {
          result += `**Nested Subtasks:** ${child.children.length}\n`
        }
        result += `\n`
        
        child.messages.forEach((taskMsg) => {
          const taskRole = taskMsg.role === 'user' ? 'User' : 'Assistant'
          const taskTimestamp = taskMsg.metadata?.time?.created ? new Date(taskMsg.metadata.time.created).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : ''
          const taskModelInfo = taskMsg.metadata?.assistant?.modelID ? taskMsg.metadata.assistant.modelID.split('/').pop() : ''
          
          result += `${heading}# ${taskRole}`
          if (taskTimestamp || taskModelInfo) {
            result += ` (${[taskModelInfo, taskTimestamp].filter(Boolean).join(' · ')})`
          }
          result += `\n\n`
          
          let taskHasContent = false
          for (const part of taskMsg.parts || []) {
            if (part.type === 'text' && part.text && part.text.trim()) {
              result += `${part.text.trim()}\n\n`
              taskHasContent = true
            }
          }
          
          if (!taskHasContent) {
            result += `*No content*\n\n`
          }
        })
        
        result += `---\n\n`
        
        // RECURSION: Render nested subtasks
        result += renderSubtaskMarkdown(child.children, depth + 1)
      })
      
      return result
    }
    
    // Process main conversation messages
    messages.forEach((message, _messageIndex) => {
      const role = message.role === 'user' ? 'User' : 'Assistant'
      const timestamp = message.metadata?.time?.created ? new Date(message.metadata.time.created).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : ''
      const modelInfo = message.metadata?.assistant?.modelID ? message.metadata.assistant.modelID.split('/').pop() : ''
      
      markdown += `## ${role}`
      if (timestamp || modelInfo) {
        markdown += ` (${[modelInfo, timestamp].filter(Boolean).join(' · ')})`
      }
      markdown += `\n\n`
      
      // Process message parts
      let hasContent = false
      for (const part of message.parts || []) {
        if (part.type === 'text') {
          if (part.text && part.text.trim()) {
            markdown += `${part.text.trim()}\n\n`
            hasContent = true
          }
        } else if (part.type === 'tool-invocation') {
          const tool = part.toolInvocation
          markdown += `🔧 **Tool: ${tool.toolName}**\n\n`
          
          if (tool.state === 'call' || tool.state === 'result') {
            if (tool.args && Object.keys(tool.args).length > 0) {
              markdown += `**Parameters:**\n`
              Object.entries(tool.args).forEach(([key, value]) => {
                const formattedValue = typeof value === 'string' && value.length > 50 
                  ? `\n\`\`\`\n${value}\n\`\`\`\n`
                  : `\`${JSON.stringify(value)}\``
                markdown += `- **${key}:** ${formattedValue}\n`
              })
              markdown += `\n`
            }
          }
          
          if (tool.state === 'result' && tool.result) {
            markdown += `**Output:**\n\`\`\`\n${tool.result}\n\`\`\`\n\n`
          }
          hasContent = true
        } else if (part.type === 'reasoning') {
          markdown += `*💭 Reasoning: ${part.text}*\n\n`
          hasContent = true
        } else if (part.type === 'file') {
          markdown += `📎 **File:** ${part.filename || part.url}\n\n`
          hasContent = true
        }
      }
      
      if (!hasContent) {
        markdown += `*No content*\n\n`
      }
      
      markdown += `---\n\n`
      
      // Check if this message contains TaskTool or AgentTool calls and add inline subtask sessions
      const subtaskToolParts = (message.parts || []).filter((part: any) => 
        part.type === 'tool-invocation' && 
        (part.toolInvocation?.toolName === 'task' || part.toolInvocation?.toolName === 'agent')
      )
      
      if (subtaskToolParts.length > 0 && childSessions.length > 0) {
        // Add recursive subtask markdown
        markdown += renderSubtaskMarkdown(childSessions, 0)
      }
    })
    
    // Add footer
    const exportDate = new Date().toLocaleDateString()
    markdown += `*Exported from OpenCode on ${exportDate}*\n`
    
    return markdown
  }

  function extractMessageText(parts: any[]): string {
    return parts
      .filter(part => part.type === 'text')
      .map(part => part.text || '')
      .join('\n\n')
  }

  function escapeHtml(text: string): string {
    if (typeof text !== 'string') return String(text)
    return text
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;')
  }
}