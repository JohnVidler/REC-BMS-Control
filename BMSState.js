let bms = {
	bvol: 0,
	minVoltage: 0,
	maxVoltage: 0,
	current: 0,
	temperature: 0,
	packVoltage: 0,
	charge: 50,
	health: 50,
	cellVoltage: [0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0],
	cellDelta: [0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0],
	cellFlags: ["","","","","","","","","","","","","","","",""],
	rs485: {}
};

module.exports = bms;
