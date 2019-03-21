const path = require('path');
const fs = require('fs');

let rFindFiles = (path) =>
    fs.readdirSync(path).map(o => path+'/'+o)
    .map(o => fs.lstatSync(o).isDirectory() ? rFindFiles(o) : [o]).flat();

let ithrow = x => {throw x;};

let gmatch = (re_, str) => {
    let re = new RegExp(re_);
    if(!re.global) throw "Given regular expression is not global";
    let r = [], match;
    while((match = re.exec(str)))
	r.push(match);
    return r;
};

let givenPath = process.argv[2];
if(!givenPath)
    throw "call this script this way: node scriptname.js /path/to/dir/";

let inhRe = /((?:\s*(?:total|reifiable|reflectable)\s*)*)new_effect\s*(\S+)\s*=\s*(\S+)\s*/mg;
let expRe = /((?:\s*(?:total|reifiable|reflectable)\s*)*)new_effect\s*{(?:.*\n)?\s*(\S+)(.*)/mg;
let subEffectsRe = /sub_effect\s*(\S*)\s*~>\s*(\S*)/gm;
let find = re => {
    let files = rFindFiles(givenPath).filter(x => x.match(re));
    
    let dicts = files.map(path => {
	let src = fs.readFileSync(path);
	let effectsDict = {};

	let newLineMap = gmatch(/\n/gm, src).map(x => x.index);
	let getNumberOfLine = tpos => newLineMap.findIndex(nlpos => tpos < nlpos);

	let ff=f=>x=>{let r = f(x); r.line = getNumberOfLine(x.index); return r;};
	let i=gmatch(inhRe, src).map(ff(([_, flags, name, inheritFrom]) =>
				       ({flags, name, inheritFrom})));
	let e=gmatch(expRe, src).map(ff(([_, flags, name]) => ({flags, name})));
	
	[...i, ...e].forEach(o => {
	    o.reflectable = !!o.flags.match('reflectable');
	    o.reifiable = !!o.flags.match('reifiable');
	    o.tot = !!o.flags.match('total') || o.name == "PURE" || o.name == "GHOST";
	    if(o.name == '//')
		return;
	    o.name = o.name.replace(/:/g, '');
	    if(effectsDict[o.name])
		throw "Err "+o.name+" is a duplicate";
	    o.liftableTo = [];
	    o.path = path;
	    effectsDict[o.name] = o;
	});

	let aliases = gmatch(/\n[ \s]*\beffect\s+(\S+)\s+[^=]*=\s+(?:\/\/.*\n)?\s*(\S+)/gm, src)
	    .map(([_, Alias, Original]) => ({Alias, Original, path}));
	let subEffects = gmatch(subEffectsRe, src).map(([_, From, To]) => ({From, To}));
	return [aliases, subEffects, effectsDict];
    });

    let dict = {};
    let aliases = [];
    let subEffects = [];
    dicts.forEach(([aliases0, subEffects0, d]) => Object.keys(d).map(k => {
	aliases0.map(x => aliases.find(o => o.Alias == x.Alias) || aliases.push(x));
	subEffects.push(...subEffects0);
	dict[k] = d[k];
    }));

    let computeSubEffectDependencies = o => {
    	let check = k => {
	    let v = o[k];
	    if(!dict[v])
		if(v.indexOf('.')!=-1){
		    o[k] = v.replace(/^[^.]*\./, '');
		    check(k);
		}else
		    throw "Err "+v+" (in \""+o.From+" ~> "+o.To+"\") not found";
	};
    	['From', 'To'].map(check);
    	dict[o.From].liftableTo.push(o.To);
    };

    let eqModPoint = (a, b) => {
	if (a == b)
	    return true;
	let r = false;
	if (a.match(/\./))
	    r = r || eqModPoint(a.replace(/^[^.]*\./, ''), b);
	if (b.match(/\./))
	    r = r || eqModPoint(a, b.replace(/^[^.]*\./, ''));
	return r;
    };

    let findProperName = (ctx, s) => dict[s] ? s : dict[s.replace(/^[^.]*\./, '')] ? s.replace(/^[^.]*\./, '') : ithrow('cannot find name '+s+" "+ctx); 
    
    let isDependentOf = (a, b) => {
	if(dict[a.Original] || dict[a.Original.replace(/^[^.]*\./, '')])
	    return false;
	if(eqModPoint(a.Original, b.Alias))
	    return true;
	let aForward;
	if((aForward = aliases.find(x => eqModPoint(x.Alias, a.Original))))
	    return isDependentOf(aForward, b);
	throw a.Original + " not found (while computing aliases dependencies) // in path=" + a.path;
    };
    aliases = aliases.sort((a, b) => isDependentOf(a, b) ? 1 : isDependentOf(b, a) ? -1 : 0);
    aliases.forEach(({Alias, Original, path}) => {
	if(dict[Alias]){
	    console.log("WARNING: Alias duplicate " + dict[Alias].name);
	    return;
	}
	Original = findProperName('mapaliases', Original);
	if(!dict[Original])
	    throw ""+Original+" not found (while linking aliases) // in path="+path;
	let aliasObj = Object.assign({}, dict[Original]);
	aliasObj.path = path;
	aliasObj.name = Alias;
	aliasObj.aliasOf = dict[Original];
	dict[Alias] = aliasObj;
    });

    subEffects.map(computeSubEffectDependencies);
    Object.keys(dict).map(k => dict[k].liftableTo = [...new Set(dict[k].liftableTo)]);
    
    return dict;
};

let effects = find(/^[^#]*\.fsti?$/);

let exportToGraphviz = (effects, style) => {
    let stylesToString = (...l) => {
	let compose = {
	    style: (a, b) => a + ',' + b
	};
	let obj = l.map(x => {
	    if(x == undefined)
		return undefined;
	    if(typeof x == 'object')
		return x;
	    return style[x];
	}).filter(x => x)
	    .reduce((acc, cur) => {
		for(let k in cur){
		    if(acc[k])
			acc[k] = (compose[k] || ((_, n) => n))(acc[k], cur[k]);
		    else
			acc[k] = cur[k];
		}
		return acc;
	    }, {});
	l = Object.keys(obj).map(k => k+'="'+obj[k]+'"');
	return (l.length ? '['+l.join(',')+']' : '');
    };

    let s = 'digraph G {\n';
    Object.keys(effects).map(k => {
	let E = effects[k];
	s += E.name + stylesToString(
	    E.aliasOf && 'aliasEffect',
	    E.inheritFrom && 'inheritedEffect',
	    E.tot && 'total',
	    E.reifiable && 'reifiable',
	    E.reflectable && 'reflectable',
	    {tooltip: E.path.substr(givenPath.length).replace(/^\//, '') + ':' + E.line}
	) + ';\n';
    });
    
    Object.keys(effects).map(k => {
	let E = effects[k];
	if(!E.aliasOf)
	    E.liftableTo.map(x => s += E.name + '->' +x+ ';\n');
	else
	    s += E.name + '->' + E.aliasOf.name +stylesToString('aliasArrow')+';\n';
    });
    
    Object.keys(effects).map(k => {
	let E = effects[k];
	if(E.inheritFrom){
	    s += E.name + '->' + E.inheritFrom +stylesToString('inheritArrow')+';\n';
	}
    });
    s += '\n}\n';
    return s;
};


fs.writeFileSync('effect-lattice.json', JSON.stringify(effects, null, 4));

let gz = exportToGraphviz(effects, {
    total: {style: 'filled', fillcolor: '#bae3ff'},
    aliasArrow: {style: 'dotted'},
    aliasEffect: {style: 'dotted'},
    reifiable: {shape: 'box'},
    reflectable: {color: '#27ae60', penwidth: '3'},
    inheritArrow: {color: '#f6e58d'}
});

let html = `
<!DOCTYPE html>
<meta charset="utf-8">
<body>
<script src="http://d3js.org/d3.v4.min.js"></script>
<script src="https://unpkg.com/viz.js@1.8.0/viz.js" type="javascript/worker"></script>
<script src="https://unpkg.com/d3-graphviz@1.4.0/build/d3-graphviz.min.js"></script>
<div id="graph" style="text-align: center;"></div>
<script>

d3.select("#graph").graphviz()
    .fade(false)
    .renderDot(\`${gz}\`);

</script>
`;

fs.writeFileSync('effect-lattice.html', html);
fs.writeFileSync('effect-lattice.dot', gz);
