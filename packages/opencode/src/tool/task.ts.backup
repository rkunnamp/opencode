import { Tool } from "./tool"
import DESCRIPTION from "./task.txt"
import { z } from "zod"
import { Session } from "../session"
import { Bus } from "../bus"
import { Message } from "../session/message"
import { Storage } from "../storage/storage"
import { Identifier } from "../id/id"
import { Provider } from "../provider/provider"

async function findProviderForModel(modelID: string): Promise<string | null> {
  try {
    const providers = await Provider.list()
    for (const [providerID, provider] of Object.entries(providers)) {
      if (provider.info.models[modelID]) {
        return providerID
      }
    }
    return null
  } catch (error) {
    return null
  }
}

async function copyMessageHistory(sourceSessionID: string, targetSessionID: string, stripLastUserMessage: boolean = true) {
  const sourceMessages = await Session.messages(sourceSessionID)
  
  let messagesToCopy = sourceMessages
  
  if (stripLastUserMessage) {
    // Find the last user message (which triggered this TaskTool)
    let lastUserMessageIndex = -1
    for (let i = sourceMessages.length - 1; i >= 0; i--) {
      if (sourceMessages[i].role === "user") {
        lastUserMessageIndex = i
        break
      }
    }
    
    // Copy all messages up to (but not including) the last user message
    messagesToCopy = lastUserMessageIndex >= 0 
      ? sourceMessages.slice(0, lastUserMessageIndex)
      : sourceMessages
  }
  
  for (const message of messagesToCopy) {
    // Create a new message with new ID but same content
    const newMessage: Message.Info = {
      ...message,
      id: Identifier.ascending("message"),
      metadata: {
        ...message.metadata,
        sessionID: targetSessionID,
        time: {
          ...message.metadata.time,
          created: Date.now(), // Update creation time
        }
      }
    }
    
    // Save the copied message to the target session
    await Storage.writeJSON(
      `session/message/${targetSessionID}/${newMessage.id}`,
      newMessage
    )
  }
}

export const TaskTool = Tool.define({
  id: "task",
  description: DESCRIPTION,
  parameters: z.object({
    description: z
      .string()
      .describe("A short (3-5 words) description of the task"),
    prompt: z.string().describe("The task for the agent to perform"),
    modelId: z.string().optional().describe("Override model ID for this task"),
    providerId: z.string().optional().describe("Override provider ID for this task"),
    inheritHistory: z.boolean().optional().describe("Copy parent message history to new task (default: false). Use when the sub-task needs conversation context to understand references, previous decisions, or build upon earlier work. Skip for independent tasks that don't need prior context. NOTE: This parameter is ignored when sessionID is provided, since you are continuing an existing conversation."),
    stripLastUserMessage: z.boolean().optional().describe("When inheritHistory is true, whether to strip the last user message from copied history (default: true). Set to false only when the last user message provides useful context rather than subtask creation instructions. WARNING: If setting to false and the last user message contains instructions to create subtasks, you MUST provide overriding instructions in your prompt to prevent infinite loops."),
    sessionID: z.string().optional().describe("Resume conversation with existing subtask session ID. If not provided, creates new subtask. Use this to continue conversations with previously created subtasks."),
  }),
  async execute(params, ctx) {
    // Create new session or get existing one
    let session
    if (params.sessionID) {
      try {
        session = await Session.get(params.sessionID)
      } catch (error) {
        throw new Error(`Failed to resume subtask: session ${params.sessionID} not found`)
      }
    } else {
      session = await Session.create(ctx.sessionID)  // Pass parent session ID as parentID
    }
    
    const msg = await Session.getMessage(ctx.sessionID, ctx.messageID)
    const metadata = msg.metadata.assistant!

    // Copy message history if requested (only for new sessions)
    if (params.inheritHistory && !params.sessionID) {
      const stripLastUserMessage = params.stripLastUserMessage ?? true
      await copyMessageHistory(ctx.sessionID, session.id, stripLastUserMessage)
    }

    function summary(input: Message.Info) {
      const result = []

      for (const part of input.parts) {
        if (part.type === "tool-invocation") {
          result.push({
            toolInvocation: part.toolInvocation,
            metadata: input.metadata.tool[part.toolInvocation.toolCallId],
          })
        }
      }
      return result
    }

    const unsub = Bus.subscribe(Message.Event.Updated, async (evt) => {
      if (evt.properties.info.metadata.sessionID !== session.id) return
      ctx.metadata({
        title: params.description,
        summary: summary(evt.properties.info),
      })
    })

    ctx.abort.addEventListener("abort", () => {
      Session.abort(session.id)
    })
    
    // Enhanced model/provider selection logic
    let modelID = params.modelId ?? metadata.modelID
    let providerID = params.providerId ?? metadata.providerID
    
    // If modelId is provided but providerId is not, try to find a provider that has the model
    if (params.modelId && !params.providerId) {
      const currentProvider = metadata.providerID
      const providers = await Provider.list()
      
      // Check if current provider has the requested model
      if (providers[currentProvider]?.info.models[params.modelId]) {
        // Current provider has the model, use it
        providerID = currentProvider
      } else {
        // Current provider doesn't have the model, search for one that does
        const foundProviderID = await findProviderForModel(params.modelId)
        if (foundProviderID) {
          providerID = foundProviderID
        }
        // If no provider found with the model, keep the current provider (will fail gracefully later)
      }
    }
    const result = await Session.chat({
      sessionID: session.id,
      modelID: modelID,
      providerID: providerID,
      parts: [
        {
          type: "text",
          text: params.prompt,
        },
      ],
    })
    unsub()
    const taskResult = result.parts.findLast((x) => x.type === "text")!.text
    const embeddedResult = `<result>${taskResult}</result>
<metadata>
sessionID: ${session.id}
title: ${params.description}
modelID: ${modelID}
providerID: ${providerID}
</metadata>`

    return {
      metadata: {
        title: params.description,
        sessionID: session.id,
        summary: summary(result),
      },
      output: embeddedResult,
    }
  },
})
