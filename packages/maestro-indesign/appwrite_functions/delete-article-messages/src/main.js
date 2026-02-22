const sdk = require("node-appwrite");

/**
 * Appwrite Function: Delete Article Messages on Article Delete
 * 
 * This function is triggered when an article is deleted from the Articles collection.
 * It automatically deletes all messages associated with that article from the ArticleMessages collection.
 * 
 * Trigger: databases.*.collections.*.documents.*.delete
 * Runtime: Node.js 18.0+
 * 
 * Environment Variables required:
 * - APPWRITE_API_KEY: An API Key with 'databases.read' and 'databases.write' scopes.
 * - DATABASE_ID: The database ID where collections are stored.
 * - ARTICLE_MESSAGES_COLLECTION_ID: The collection ID for ArticleMessages.
 */

module.exports = async function ({ req, res, log, error }) {
  // Initialize Appwrite client
  const client = new sdk.Client();
  
  client
    .setEndpoint(process.env.APPWRITE_FUNCTION_ENDPOINT || 'https://cloud.appwrite.io/v1')
    .setProject(process.env.APPWRITE_FUNCTION_PROJECT_ID)
    .setKey(process.env.APPWRITE_API_KEY);

  const databases = new sdk.Databases(client);

  try {
    // Parse the event payload
    let payload = {};
    if (req.body) {
      try {
        payload = JSON.parse(req.body);
      } catch (e) {
        payload = req.body;
      }
    }
    
    log('Event received:', JSON.stringify(payload, null, 2));

    // Extract the deleted article ID
    const deletedArticleId = payload.$id;
    
    if (!deletedArticleId) {
      error('No article ID found in event payload');
      return res.json({ 
        success: false, 
        error: 'Missing article ID in event payload' 
      }, 400);
    }

    log(`Article deleted: ${deletedArticleId}`);
    log('Searching for related messages...');

    // Query all messages related to this article
    const messages = await databases.listDocuments(
      process.env.DATABASE_ID,
      process.env.ARTICLE_MESSAGES_COLLECTION_ID,
      [sdk.Query.equal('articleId', deletedArticleId)]
    );

    const messageCount = messages.documents.length;
    log(`Found ${messageCount} message(s) to delete`);

    // Delete each message
    let deletedCount = 0;
    for (const message of messages.documents) {
      try {
        await databases.deleteDocument(
          process.env.DATABASE_ID,
          process.env.ARTICLE_MESSAGES_COLLECTION_ID,
          message.$id
        );
        deletedCount++;
        log(`Deleted message: ${message.$id}`);
      } catch (deleteError) {
        error(`Failed to delete message ${message.$id}:`, deleteError.message);
      }
    }

    log(`Successfully deleted ${deletedCount}/${messageCount} messages for article ${deletedArticleId}`);

    return res.json({ 
      success: true, 
      articleId: deletedArticleId,
      messagesFound: messageCount,
      messagesDeleted: deletedCount 
    });

  } catch (err) {
    error('Function execution failed:', err.message);
    error('Stack trace:', err.stack);
    
    return res.json({ 
      success: false, 
      error: err.message 
    }, 500);
  }
};
