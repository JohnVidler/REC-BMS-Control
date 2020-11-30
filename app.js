const SerialPort = require('serialport');
const { crc16 } = require('crc');
const Layer2 = require( './Layer2' );

const WebApp = require( './web.js' );

const fs = require('fs');

const config = JSON.parse( fs.readFileSync('./config.json') );

//Graphing
const mqtt = require( 'mqtt' );
let mqtt_client = null;
if( config.mqtt && config.mqtt.host ) {
	const mqtt_client = mqtt.connect(
		config.mqtt.host,
		{
			username: config.mqtt.username,
			password: config.mqtt.password
		}
	);
	mqtt_client.on('connect', () => {
		console.log("MQTT Connected");
	} );
}

const port = new SerialPort( config.serial.port || '/dev/ttyUSB0', {
	baudRate: config.serial.baudRate || 56000,
	dataBits: config.serial.dataBits || 8,
	stopBits: config.serial.stopBits || 1,
	parity: config.serial.parity || 'none'
} );
const layer2 = new Layer2();

port.on('error', function(err) {
	console.log('Error: ', err.message);
});

var rxBuffer = Buffer.alloc(0);

port.on( 'data', data => layer2.push(data) );



let requestBuffer = [];
let activeRequest = null;

function send( address, command ) {
	let query = Buffer.alloc(7+command.length);
	query.writeUInt8( 0x55, 0 ); // BEGIN Always
	query.writeUInt8( address, 1 ); // Destination (Normally 0x01, unless multiple units on the bus)
	query.writeUInt8( 0x00, 2 ); // Sender (always 0x00)
	query.writeUInt8( command.length, 3 ); // Length

	command.copy( query, 4 ); // Copy the entire input command to the query buffer

	query.writeUInt16BE( crc16( query.slice(1,query.length-3) ), query.length-3 );
	query.writeUInt8( 0xAA, query.length-1 ); // END Always

	port.write( query );
}

function query( _address, _command, _callback ) {
	let op = {
		address: _address,
		command: _command,
		callback: _callback
	};
	requestBuffer.push( op );
}
handleRequest();

async function handleRequest() {
	if( requestBuffer.length > 0 && activeRequest === null ) {
		activeRequest = requestBuffer.shift();
		activeRequest.timeout = setTimeout( ()=>{
			console.log( `Query timeout -> ${activeRequest.command.toString()}` );
			layer2.on( "data", ()=> {} ); // Null handler
			activeRequest = null; // Drop the active request
		}, 350 );

		layer2.on( "data", (packet) => {
			try {
				// Are we done?
				if( activeRequest.callback(packet) ) {
					clearTimeout( activeRequest.timeout );
					layer2.on( "data", ()=> {} ); // Null handler
					activeRequest = null; // Drop the active request
				}
			} catch( err ) {
				console.log( `Error in handler, reset: ${err}` );
				console.log( err );
				layer2.on( "data", ()=> {} ); // Null handler
				activeRequest = null; // Drop the active request
			}
		} );

		send( activeRequest.address, activeRequest.command );
	}

	setTimeout( handleRequest, 20 );
}


function terminalBar( value, max = 100, min = 0 ) {
	const barGlyph = [ '\u258F', '\u258E', '\u258D', '\u258C', '\u258B', '\u258A', '\u2589', '\u2588' ];

	process.stdout.write( '[' );
	for( let i=Math.floor(min); i<Math.ceil(max); i+=8 ){
		try {
			if( value < i )
				process.stdout.write( ' ' );
			else if( value >= (Math.floor(i/8)*8)+8 )
				process.stdout.write( barGlyph[7] );
			else
				process.stdout.write( barGlyph[value%8] );
		}catch(err){
			// Skip... just a render error
		}
	}
	process.stdout.write( ']' );
}

function terminalDot( value, max = 100, min = 0 ) {
	process.stdout.write( '[' );
	value = Math.floor( value );
	for( let i=Math.floor(min); i<Math.ceil(max); i++ ){
		try {
			if( value == i ) {
				process.stdout.write( '|' );
			} else {
				if( i < 0 && i > value )
					process.stdout.write( '<' );
				else if( i > 0 && i < value )
					process.stdout.write( '>' );
				else
					process.stdout.write( ' ' );
			}
		}catch(err){
			// Skip... just a render error
		}
	}
	process.stdout.write( ']' );
}

let bms = require( './BMSState.js' );

port.on( 'open', function() {
	console.log( 'Port open!' );

	setInterval( () => {

		query( 0x01, Buffer.from(`CHEM 3`), () => true ); // LiFEP04 chemistry (?)
		//query( 0x01, Buffer.from(`SOCS 1.0`), () => true ); // SOC == 100%

		query( 0x01, Buffer.from(`BMIN ${config.charge.bMin}`), () => true );
		query( 0x01, Buffer.from(`BVOL ${config.charge.bMax}`), () => true );

		query( 0x01, Buffer.from(`CMAX ${config.cell.vMax}`), () => true );
		query( 0x01, Buffer.from(`CHAR ${config.cell.vNom}`), () => true );
		query( 0x01, Buffer.from(`CMIN ${config.cell.vMin}`), () => true );

		bms.cellFlags = bms.cellFlags.map( (r) => "---" );
		query( 0x01, Buffer.from(`ERRO?`), (packet) => {
			if( packet.length === 8 )
				return false;

			let bms_id = packet.readUInt8( 4+1 );
			let bms_err = packet.readUInt8( 4+2 );
			let bms_loc = packet.readUInt8( 4+3 );

			switch( bms_err ) {
				case 0:
					console.log( "No error..." );
					break;
				case 1:
					bms.cellFlags[bms_loc] = "SHUNT";
					break;
				case 2:
					bms.cellFlags[bms_loc] = "CHARGE";
					break;
				case 3:
					bms.cellFlags[bms_loc] = "BALANCE";
					console.log( "<<< BALANCING... >>>", bms_loc );
					break;
				case 5:
					console.log( "!!! O V E R H E A T !!!" );
					break;

				default:
					for( let i=0; i<packet.length; i++ )
						process.stdout.write( `${packet.readUInt8(i).toString(16)} ` );
					console.log("");
					console.log( `Unknown error code ${bms_err} / ${bms_loc}` );
			}
			
			return true;
		} );

		// Query for all the general info from the BMS (LCD stuff)
		query( 0x01, Buffer.from("LCD1?"), (packet) => {
			if( packet.length < 32 )
				return false;

			bms.minVoltage  = packet.readFloatLE( 4+ 0 );
			bms.maxVoltage  = packet.readFloatLE( 4+ 4 );
			bms.current     = packet.readFloatLE( 4+ 8 );
			bms.temperature = packet.readFloatLE( 4+ 12 );
			bms.packVoltage = packet.readFloatLE( 4+ 16 );
			bms.charge      = packet.readFloatLE( 4+ 20 ) * 100;
			bms.health      = packet.readFloatLE( 4+ 24 ) * 100;

			return true;
		} );

		query( 0x01, Buffer.from("CHAR?"), (packet) => {
			if( packet.length !== 16 )
				return false;

			let payload = packet.slice( 4, packet.readUInt8(3) );
			let voltage = payload.toString();

			console.log( `CHAR = ${voltage}` );

			return true;
		});

		// Query the current balance voltages
		query( 0x01, Buffer.from("BVOL?"), (packet) => {
			if( packet.length !== 16 )
				return false;

			let payload = packet.slice( 4, packet.readUInt8(3) );
			bms.bvol = payload.toString();

			return true;
		});
		query( 0x01, Buffer.from("BMIN?"), (packet) => {
			if( packet.length !== 16 )
				return false;

			let payload = packet.slice( 4, packet.readUInt8(3) );
			bms.bmin = payload.toString();

			return true;
		});

		// Grab all the cell voltages
		query( 0x01, Buffer.from("CELL?"), (packet) => {
			if( packet.readUInt8(3) !== 64 )
				return false;

			let payload = packet.slice( 4 );

			for( let i=0; i<16; i++ ) {
				let value = payload.readFloatLE( i*4 );
				bms.cellDelta[i] = value - (bms.cellVoltage[i] || 0);
				bms.cellVoltage[i] = value;
			}

			return true;
		});


		bms.rs485.packets = layer2.stats.rx;
		bms.rs485.bytes = layer2.stats.rxBytes;
		bms.rs485.badCRC = layer2.stats.badCRC;
		bms.rs485.backlog = requestBuffer.length;

	}, 1000 );
});


let cycle = 0;
setInterval( ()=>{
		let packHealth    = Math.round(bms.health * 100) / 100;
		let temperature   = Math.round(bms.temperature * 100) / 100;
		let packVoltage   = Math.round(bms.packVoltage * 1000) / 1000;
		let chargePercent = Math.round(bms.charge * 1000) / 1000;
		let vMin = 5;
		let vMax = 0;


		console.log('\033c');
		console.log("\33[2J");
		console.log( `Pack Voltage: ${packVoltage} v\t(${chargePercent} %)` )
		console.log( `Pack Health: ${packHealth} %\tPack Temperature ${temperature} °C` );
		console.log( `Battery Balancing: ${bms.bmin} - ${bms.bvol} v\n` );

		process.stdout.write( "Current: " );
		terminalDot( bms.current*10, 10, -10 );
		console.log( `\t${Math.floor(bms.current*100)/100} A\n` );

		for( let i=0; i<bms.cellVoltage.length; i++ ) {
			let delta = '   ';
			if( bms.cellDelta[i] > 0 )
				delta = '>>>';
			if( bms.cellDelta[i] < 0 )
				delta = '<<<';

			let voltage = Math.round( bms.cellVoltage[i] * 10000.0 ) / 10000.0;
			let percent = Math.round( ((voltage - config.cell.vMin) / (config.cell.vMax - config.cell.vMin)) * 10000.0 ) / 100.0;
			let targetDelta = Math.round( (config.cell.vMax-voltage) * 1000.0 ) / 1000.0

			let warning = "";
			if( voltage < config.cell.vMin )
				warning = "LOW";

			if( voltage >= config.cell.vMax-0.05 )
				warning = "***";
			
			if( voltage >= config.cell.vMax )
				warning = "HIGH";

			if( bms.cellVoltage[i] < vMin )
				vMin = bms.cellVoltage[i];
			if( bms.cellVoltage[i] > vMax )
				vMax = bms.cellVoltage[i];

			process.stdout.write( `${i}\t` );
			terminalBar( bms.cellVoltage[i] * 400, config.cell.vMax * 400, config.cell.vMin * 400 );
			console.log(`  \t${voltage} v,\t${percent}%\t${delta}\t${warning}\t${bms.cellFlags[i]}\t${targetDelta}`);
		}
		
		console.log( `Pack voltage-spread: ${Math.round((vMax - vMin)*1000)/1000}v` );

		console.log( `Packets: ${layer2.stats.rx}\tBytes: ${layer2.stats.rxBytes}\tErrors: ${layer2.stats.badCRC}\tPending Req: ${requestBuffer.length}` );

		if( mqtt_client != null ) {
			console.log( "Send MQTT" );
			mqtt_client.publish( 'bms', JSON.stringify({
				"health": packHealth,
				"temperature": temperature,
				"voltage": packVoltage,
				"charge": chargePercent,
				"vMin": vMin,
				"vMax": vMax
			}), {}, (err) => { console.log("MQTT -> ", err); } );
		}

		// Save to local log:
		if( config.log || false == true ) {
			let csvData = [
				bms.charge,
				bms.packVoltage,
				`${vMax - vMin}`,
				...bms.cellVoltage
			];
			fs.appendFileSync('log.csv', csvData.join("\t") + "\n");
		}

		cycle++;
}, 1000 );
