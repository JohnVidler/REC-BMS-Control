const Express = require( 'express' );
const ExpressBasicAuth = require( 'express-basic-auth' );

const config = {
	port: 3000,
	user: null,
	pass: null
};

const app = Express();
app.listen( config.port, () => { console.log(`Listening on port ${config.port}`) } );

// Actually bother to load a config file before here :)
let userList = {};
if( config.user !== null && config.pass !== null)
	userList[config.user] = config.pass;

if( Object.keys(userList) > 0 ) {
	console.log( `Enabling basic authentication, had non-zero users to allow :)` );
	app.use(ExpressBasicAuth({users: userList}));
}

app.use( require('./routes.js') );
