const i2c = require('i2c-bus');

module.exports = function (app) {
    let isRunning = false;
    let timeoutTimer = null;
    let readingsBuffer = {};
    const plugin = {};

    plugin.id = 'signalk-mcp3424-analog-reader';
    plugin.name = 'MCP3424 Analog Reader';
    plugin.description = 'Liest Spannung auf CH1 sowie 0-190 Ohm Tanksensoren auf CH2 und CH3 aus';

    plugin.schema = {
        type: 'object',
        properties: {
            i2c_address: { type: 'number', default: 0x68, title: 'I2C Adresse (meist 0x68)' },
            interval: { type: 'number', default: 2000, title: 'Update Intervall (ms)' },
            ch1_voltage_multiplier: { type: 'number', default: 11.0, title: 'CH1: Spannungsmultiplikator (für 0-20V Input, z.B. 11 bei 100k/10k Spannungsteiler)' },
            ch1_path: { type: 'string', default: 'electrical.batteries.1.voltage', title: 'CH1: SignalK Pfad (Spannung)' },
            ch2_path: { type: 'string', default: 'vessels.self.tanks.freshWater.0.currentLevel', title: 'CH2: SignalK Pfad (Tank 1, 0-190 Ohm)' },
            ch3_path: { type: 'string', default: 'vessels.self.tanks.fuel.0.currentLevel', title: 'CH3: SignalK Pfad (Tank 2, 0-190 Ohm)' },
            r_pullup: { type: 'number', default: 470, title: 'CH2/CH3: Pull-up Widerstand (Ohm)' },
            u_ref: { type: 'number', default: 5.0, title: 'CH2/CH3: Referenzspannung (Volt)' },
            buffer_size: { type: 'number', default: 10, title: 'Dämpfung (Anzahl Messwerte)' }
        }
    };

    function processOhmSensor(chName, voltage, path, options) {
        let rSensor = options.r_pullup * (voltage / (options.u_ref - voltage));

        // Glättung
        if (!readingsBuffer[chName]) readingsBuffer[chName] = [];
        readingsBuffer[chName].push(rSensor);
        if (readingsBuffer[chName].length > options.buffer_size) readingsBuffer[chName].shift();

        const avgR = readingsBuffer[chName].reduce((a, b) => a + b, 0) / readingsBuffer[chName].length;

        // Mapping 0-190 Ohm zu 0.0-1.0 Ratio
        let ratio = avgR / 190;
        if (ratio < 0) ratio = 0;
        if (ratio > 1) ratio = 1;

        return { path: path, value: ratio };
    }

    plugin.start = function (options) {
        const bus = i2c.openSync(1);
        isRunning = true;

        function readChannel(configByte, callback) {
            if (!isRunning) return;
            try {
                bus.sendByteSync(options.i2c_address, configByte);
                setTimeout(() => {
                    if (!isRunning) return;
                    try {
                        const buffer = Buffer.alloc(4);
                        bus.i2cReadSync(options.i2c_address, 4, buffer);

                        let rawValue = ((buffer[0] & 0x03) << 16) | (buffer[1] << 8) | buffer[2];
                        if (buffer[0] & 0x02) rawValue -= 0x40000;

                        const voltage = rawValue * 0.000015625;
                        callback(null, voltage);
                    } catch (err) {
                        callback(err);
                    }
                }, 300); // 300ms reicht für 18-bit One-Shot Messung (max 266ms)
            } catch (err) {
                callback(err);
            }
        }

        function readSequence() {
            if (!isRunning) return;

            const ch1Mult = options.ch1_voltage_multiplier || 11.0;

            // CH1 auslesen: 0x8C -> One-Shot, 18-bit, PGA1
            readChannel(0x8C, (err, v1) => {
                if (!isRunning) return;
                if (err) {
                    app.error("Fehler beim Lesen von CH1: " + err.message);
                    timeoutTimer = setTimeout(readSequence, options.interval);
                    return;
                }

                const valCh1 = v1 * ch1Mult;
                const updates = [{ path: options.ch1_path, value: valCh1 }];

                // CH2 auslesen: 0xAC -> One-Shot, 18-bit, PGA1
                readChannel(0xAC, (err, v2) => {
                    if (!isRunning) return;
                    if (err) {
                        app.error("Fehler beim Lesen von CH2: " + err.message);
                        timeoutTimer = setTimeout(readSequence, options.interval);
                        return;
                    }

                    updates.push(processOhmSensor("ch2", v2, options.ch2_path, options));

                    // CH3 auslesen: 0xCC -> One-Shot, 18-bit, PGA1
                    readChannel(0xCC, (err, v3) => {
                        if (!isRunning) return;
                        if (err) {
                            app.error("Fehler beim Lesen von CH3: " + err.message);
                            timeoutTimer = setTimeout(readSequence, options.interval);
                            return;
                        }

                        updates.push(processOhmSensor("ch3", v3, options.ch3_path, options));

                        // Werte an Signal K senden
                        app.handleMessage(plugin.id, {
                            updates: [{
                                values: updates
                            }]
                        });

                        // Nächsten Durchlauf planen
                        timeoutTimer = setTimeout(readSequence, options.interval);
                    });
                });
            });
        }

        // Ersten Lesevorgang starten
        readSequence();
    };

    plugin.stop = function () {
        isRunning = false;
        if (timeoutTimer) clearTimeout(timeoutTimer);
        app.debug("MCP3424 Plugin gestoppt");
    };

    return plugin;
};