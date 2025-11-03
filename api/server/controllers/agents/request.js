const { sendEvent } = require('@librechat/api');
const { logger } = require('@librechat/data-schemas');
const { Constants } = require('librechat-data-provider');
const {
  handleAbortError,
  createAbortController,
  cleanupAbortController,
} = require('~/server/middleware');
const { disposeClient, clientRegistry, requestDataMap } = require('~/server/cleanup');
const { saveMessage } = require('~/models');

function createCloseHandler(abortController) {
  return function (manual) {
    if (!manual) {
      logger.info('[AgentController] Request closed (res.on close event)');
    }
    if (!abortController) {
      logger.warn('[AgentController] No abortController present in close handler');
      return;
    } else if (abortController.signal.aborted) {
      logger.info('[AgentController] AbortController already aborted in close handler');
      return;
    } else if (abortController.requestCompleted) {
      logger.info('[AgentController] Request already completed in close handler');
      return;
    }

    logger.warn('[AgentController] Aborting request due to close event');
    abortController.abort();
    logger.debug('[AgentController] Request aborted on close');
  };
}

const AgentController = async (req, res, next, initializeClient, addTitle) => {
  let {
    text,
    isRegenerate,
    endpointOption,
    conversationId,
    isContinued = false,
    editedContent = null,
    parentMessageId = null,
    overrideParentMessageId = null,
    responseMessageId: editedResponseMessageId = null,
  } = req.body;

  let sender;
  let abortKey;
  let userMessage;
  let promptTokens;
  let userMessageId;
  let responseMessageId;
  let userMessagePromise;
  let getAbortData;
  let client = null;
  let cleanupHandlers = [];

  const newConvo = !conversationId;
  const userId = req.user.id;

  // Create handler to avoid capturing the entire parent scope
  let getReqData = (data = {}) => {
    for (let key in data) {
      if (key === 'userMessage') {
        userMessage = data[key];
        userMessageId = data[key].messageId;
      } else if (key === 'userMessagePromise') {
        userMessagePromise = data[key];
      } else if (key === 'responseMessageId') {
        responseMessageId = data[key];
      } else if (key === 'promptTokens') {
        promptTokens = data[key];
      } else if (key === 'sender') {
        sender = data[key];
      } else if (key === 'abortKey') {
        abortKey = data[key];
      } else if (!conversationId && key === 'conversationId') {
        conversationId = data[key];
      }
    }
  };

  // Create a function to handle final cleanup
  const performCleanup = () => {
    logger.info('[AgentController] Performing cleanup');
    if (Array.isArray(cleanupHandlers)) {
      for (const handler of cleanupHandlers) {
        try {
          if (typeof handler === 'function') {
            handler();
          }
        } catch (e) {
          logger.error('[AgentController] Error in cleanup handler', e);
        }
      }
    }

    // Clean up abort controller
    if (abortKey) {
      logger.info('[AgentController] Cleaning up abort controller');
      cleanupAbortController(abortKey);
    }

    // Dispose client properly
    if (client) {
      logger.info('[AgentController] Disposing client');
      disposeClient(client);
    }

    // Clear all references
    client = null;
    getReqData = null;
    userMessage = null;
    getAbortData = null;
    endpointOption.agent = null;
    endpointOption = null;
    cleanupHandlers = null;
    userMessagePromise = null;

    // Clear request data map
    if (requestDataMap.has(req)) {
      logger.info('[AgentController] Clearing requestDataMap for req');
      requestDataMap.delete(req);
    }
    logger.info('[AgentController] Cleanup completed');
  };

  try {
    logger.info('[AgentController] Begin request processing');
    let prelimAbortController = new AbortController();
    const prelimCloseHandler = createCloseHandler(prelimAbortController);
    res.on('close', prelimCloseHandler);
    const removePrelimHandler = (manual) => {
      try {
        prelimCloseHandler(manual);
        res.removeListener('close', prelimCloseHandler);
      } catch (e) {
        logger.error('[AgentController] Error removing close listener', e);
      }
    };
    cleanupHandlers.push(removePrelimHandler);
    logger.debug('[AgentController] Initializing client...');
    /** @type {{ client: TAgentClient; userMCPAuthMap?: Record<string, Record<string, string>> }} */
    const result = await initializeClient({
      req,
      res,
      endpointOption,
      signal: prelimAbortController.signal,
    });
    if (prelimAbortController.signal?.aborted) {
      logger.warn('[AgentController] Request was aborted before initialization could complete');
      prelimAbortController = null;
      throw new Error('Request was aborted before initialization could complete');
    } else {
      prelimAbortController = null;
      removePrelimHandler(true);
      cleanupHandlers.pop();
    }
    client = result.client;

    // Register client with finalization registry if available
    if (clientRegistry) {
      logger.debug('[AgentController] Registering client with registry');
      clientRegistry.register(client, { userId }, client);
    }

    // Store request data in WeakMap keyed by req object
    requestDataMap.set(req, { client });
    logger.debug('[AgentController] Stored client in requestDataMap');

    // Use WeakRef to allow GC but still access content if it exists
    const contentRef = new WeakRef(client.contentParts || []);

    // Minimize closure scope - only capture small primitives and WeakRef
    getAbortData = () => {
      // Dereference WeakRef each time
      const content = contentRef.deref();

      return {
        sender,
        content: content || [],
        userMessage,
        promptTokens,
        conversationId,
        userMessagePromise,
        messageId: responseMessageId,
        parentMessageId: overrideParentMessageId ?? userMessageId,
      };
    };

    const { abortController, onStart } = createAbortController(req, res, getAbortData, getReqData);
    const closeHandler = createCloseHandler(abortController);
    res.on('close', closeHandler);
    cleanupHandlers.push(() => {
      try {
        res.removeListener('close', closeHandler);
      } catch (e) {
        logger.error('[AgentController] Error removing close listener', e);
      }
    });
    logger.debug('[AgentController] Created abort controller and close handler');

    const messageOptions = {
      user: userId,
      onStart,
      getReqData,
      isContinued,
      isRegenerate,
      editedContent,
      conversationId,
      parentMessageId,
      abortController,
      overrideParentMessageId,
      isEdited: !!editedContent,
      userMCPAuthMap: result.userMCPAuthMap,
      responseMessageId: editedResponseMessageId,
      progressOptions: {
        res,
      },
    };

    logger.info('[AgentController] Calling client.sendMessage...');
    let response = await client.sendMessage(text, messageOptions);
    logger.info('[AgentController] client.sendMessage completed');

    // Extract what we need and immediately break reference
    const messageId = response.messageId;
    const endpoint = endpointOption.endpoint;
    response.endpoint = endpoint;

    // Store database promise locally
    const databasePromise = response.databasePromise;
    delete response.databasePromise;

    // Resolve database-related data
    const { conversation: convoData = {} } = await databasePromise;
    const conversation = { ...convoData };
    conversation.title =
      conversation && !conversation.title ? null : conversation?.title || 'New Chat';

    // Process files if needed
    if (req.body.files && client.options?.attachments) {
      userMessage.files = [];
      const messageFiles = new Set(req.body.files.map((file) => file.file_id));
      for (let attachment of client.options.attachments) {
        if (messageFiles.has(attachment.file_id)) {
          userMessage.files.push({ ...attachment });
        }
      }
      delete userMessage.image_urls;
    }

    // Only send if not aborted
    if (!abortController.signal.aborted) {
      // Create a new response object with minimal copies
      const finalResponse = { ...response };
      logger.info('[AgentController] Sending final event and ending response');
      sendEvent(res, {
        final: true,
        conversation,
        title: conversation.title,
        requestMessage: userMessage,
        responseMessage: finalResponse,
      });
      res.end();

      // Save the message if needed
      if (client.savedMessageIds && !client.savedMessageIds.has(messageId)) {
        logger.debug('[AgentController] Saving message to database');
        await saveMessage(
          req,
          { ...finalResponse, user: userId },
          { context: 'api/server/controllers/agents/request.js - response end' },
        );
      }
    }
    // Edge case: sendMessage completed but abort happened during sendCompletion
    // We need to ensure a final event is sent
    else if (!res.headersSent && !res.finished) {
      logger.warn('[AgentController] Handling edge case: `sendMessage` completed but aborted during `sendCompletion`');

      const finalResponse = { ...response };
      finalResponse.error = true;

      sendEvent(res, {
        final: true,
        conversation,
        title: conversation.title,
        requestMessage: userMessage,
        responseMessage: finalResponse,
        error: { message: 'Request was aborted during completion' },
      });
      res.end();
    }

    // Save user message if needed
    if (!client.skipSaveUserMessage) {
      logger.debug('[AgentController] Saving user message to database');
      await saveMessage(req, userMessage, {
        context: "api/server/controllers/agents/request.js - don't skip saving user message",
      });
    }

    // Add title if needed - extract minimal data
    if (addTitle && parentMessageId === Constants.NO_PARENT && newConvo) {
      addTitle(req, {
        text,
        response: { ...response },
        client,
      })
          .then(() => {
            logger.info('[AgentController] Title generation started');
          })
          .catch((err) => {
            logger.error('[AgentController] Error in title generation', err);
          })
          .finally(() => {
            logger.info('[AgentController] Title generation completed');
            performCleanup();
          });
    } else {
      performCleanup();
    }
  } catch (error) {
    logger.error('[AgentController] Caught error in main handler', error);
    // Handle error without capturing much scope
    handleAbortError(res, req, error, {
      conversationId,
      sender,
      messageId: responseMessageId,
      parentMessageId: overrideParentMessageId ?? userMessageId ?? parentMessageId,
      userMessageId,
    })
      .catch((err) => {
        logger.error('[api/server/controllers/agents/request] Error in `handleAbortError`', err);
      })
      .finally(() => {
        logger.info('[AgentController] Cleanup after error');
        performCleanup();
      });
  }
};

module.exports = AgentController;
