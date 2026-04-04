const sdk = require("node-appwrite");
/*
  Appwrite Function: Get Team Members
  Returns a list of members (name, email, id) for a given teamId.
  Bypasses client-side privacy restrictions by using an API Key.
  
  Environment Variables required:
  - APPWRITE_API_KEY: An API Key with 'teams.read' and 'users.read' scopes.
*/
module.exports = async function ({ req, res, log, error }) {
  const client = new sdk.Client();
  
  // Initialize Client
  // APPWRITE_FUNCTION_ENDPOINT and APPWRITE_FUNCTION_PROJECT_ID are automatically set by Appwrite
  client
    .setEndpoint(process.env.APPWRITE_FUNCTION_ENDPOINT || 'https://cloud.appwrite.io/v1')
    .setProject(process.env.APPWRITE_FUNCTION_PROJECT_ID)
    .setKey(process.env.APPWRITE_API_KEY);
  const teams = new sdk.Teams(client);
  try {
    // Parse Payload
    let payload = {};
    if (req.body) {
        try {
            payload = JSON.parse(req.body);
        } catch (e) {
            // Use body as is if not JSON string
            payload = req.body;
        }
    }
    
    // Support GET query parameters or POST body
    const teamId = payload.teamId || req.query.teamId;
    if (!teamId) {
      return res.json({ success: false, message: "Missing teamId parameter" }, 400);
    }
    log(`Fetching members for team: ${teamId}`);
    // Fetch Memberships
    const response = await teams.listMemberships(teamId);
    // Filter and map relevant data
    const members = response.memberships.map(m => ({
      userId: m.userId,
      name: m.userName,
      email: m.userEmail,
      roles: m.roles
    }));
    
    log(`Found ${members.length} members.`);
    return res.json({
      success: true,
      members: members
    });
  } catch (err) {
    error("Error fetching members: " + err.message);
    return res.json({
      success: false,
      message: err.message
    }, 500);
  }
};