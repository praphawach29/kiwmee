const { mediaUploadRoute } = require('../../../../../../src/v2/media-upload');

// Raw binary only. Authorization/owner checks precede bounded reads and sharp decoding.
const POST = mediaUploadRoute();
const runtime = 'nodejs';
module.exports = { POST, runtime };
