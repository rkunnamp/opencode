import { Tool } from "./tool"
import DESCRIPTION from "./task.txt"
import { z } from "zod"
import { Session } from "../session"
import { Bus } from "../bus"
import { Message } from "../session/message"
import { Storage } from "../storage/storage"
import { Identifier } from "../id/id"

async function copyMessageHistory(sourceSessionID: string, targetSessionID: string) {
  const sourceMessages = await Session.messages(sourceSessionID)
  
  // Find the last user message (which triggered this TaskTool)
  let lastUserMessageIndex = -1
  for (let i = sourceMessages.length - 1; i >= 0; i--) {
    if (sourceMessages[i].role === "user") {
      lastUserMessageIndex = i
      break
    }
  }
  
  // Copy all messages up to (but not including) the last user message
  const messagesToCopy = lastUserMessageIndex >= 0 
    ? sourceMessages.slice(0, lastUserMessageIndex)
    : sourceMessages
  
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
    inheritHistory: z.boolean().optional().describe("Copy parent message history to new task (default: false). Use when the sub-task needs conversation context to understand references, previous decisions, or build upon earlier work. Skip for independent tasks that don't need prior context."),
  }),
  async execute(params, ctx) {
    const session = await Session.create(ctx.sessionID)  // Pass parent session ID as parentID
    const msg = await Session.getMessage(ctx.sessionID, ctx.messageID)
    const metadata = msg.metadata.assistant!

    // Copy message history if requested
    if (params.inheritHistory) {
      await copyMessageHistory(ctx.sessionID, session.id)
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
    const modelID = params.modelId ?? metadata.modelID
    const providerID = params.providerId ?? metadata.providerID
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
    return {
      metadata: {
        title: params.description,
        summary: summary(result),
      },
      output: result.parts.findLast((x) => x.type === "text")!.text,
    }
  },
})
