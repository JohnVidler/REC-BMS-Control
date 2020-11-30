const Express = require( 'express' );
const router = Express.Router();
const Path = require( 'path' );

router.use( Express.static( Path.join(__dirname, 'public')) );

router.get( '/state', (req, res) => {
	res.json( require('./BMSState.js') );
} );

module.exports = router;
