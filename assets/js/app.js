var Settings = {
    editor: {
        fontSize: '16px',
        languageMode: 'ace/mode/javascript',
        theme: 'ace/theme/monokai'
    }
};

var executeJS = (function(){
    function evalWrapperSafe(code) {
        var window = undefined;
        var console = undefined;
        return eval(code);
    }
    
    function evalWrapperUnsafe(code) {
        return eval(code);
    }
    
    function executeJS(code, context, safe) {
        if (safe !== false) {
            return evalWrapperSafe.call(context, code);
        } else {
            return evalWrapperUnsafe.call(context, code);
        }
    }
    
    return executeJS;
})();

var stringifyAST = (function(){
    function dropLocations(key, value) {
        if (key === 'loc') return undefined;
        return value;
    }
    
    function stringifyAST(ast) {
        return JSON.stringify(ast, dropLocations);
    }
    
    return stringifyAST;
})();

var World2Code = (function(){
    function World2Code(editor, statement_ast, world_object) {
        this.editor = editor;
        this.ast = traverse(statement_ast).clone();
        this.obj = world_object;
    }
    
    World2Code.prototype = {
        constructor: World2Code
    };
    
    return World2Code;
})();

function getExpressionAST(expression, options) {
    return esprima.parse(expression, options).body[0].expression;
}

function getLiteralAST(literal, options) {
    return getExpressionAST('(' + JSON.stringify(literal) + ')', options);
}

function makeWrapDecorator(wrapped_name) {
    var decorator_callee_node = getExpressionAST(wrapped_name);
    return function(expression) {
        return {
            type: 'CallExpression',
            callee: decorator_callee_node,
            arguments: [expression]
        };
    }
}

function makeRenameDecorator(new_name) {
    return function(expression) {
        var result = traverse(expression).clone();
        var new_callee_node = getExpressionAST(new_name);
        result.callee = new_callee_node;
        return result;
    }
}

var Decorators = {
    //'createElement': makeRenameDecorator('this.createElement')
    'createElement': [
        function(expression) {
            var wrapper_callee = getExpressionAST('this.makeWorld2Code');
            var renamed_expression = traverse(expression).clone();
            renamed_expression.callee = getExpressionAST('this.createElement');
            return {
                type: 'CallExpression',
                callee: wrapper_callee,
                arguments: [getExpressionAST('this.editor'), getLiteralAST(expression), renamed_expression]
            }
        }]
};

var ASTToDecorators = {};
for (var key in Decorators) {
    if (!Decorators.hasOwnProperty(key)) continue;
    var callee_string = stringifyAST(getExpressionAST(key));
    if (typeof Decorators[key] === 'function') {
        ASTToDecorators[callee_string] = [Decorators[key]];
    } else {
        ASTToDecorators[callee_string] = Decorators[key];
    }
}

var decorateAST = (function(){
    function isDecoratable(ast_node, ast_mapping) {
        return  ast_node.type && 
                ast_node.type === 'CallExpression' &&
                ast_node.callee &&
                ast_mapping[stringifyAST(ast_node.callee)]
    }

    function decorateASTNode(ast_node, ast_mapping) {
        var callee_string = stringifyAST(ast_node.callee);
        
        var result = ast_node;
        for (var i = 0; i < ast_mapping[callee_string].length; ++i) {
            var result = ast_mapping[callee_string][i](result);
        }
        
        return result;
    }

    function decorateAST(ast, ast_mapping) {
        return traverse(ast).map(function() {
            if (isDecoratable(this.node, ast_mapping)) {
                this.update(decorateASTNode(this.node, ast_mapping), true);
            }
        });
        return ast;
    }
    
    return decorateAST;
})();

function replaceAt(str, start, end, replacement) {
    return str.substring(0, start) + replacement + str.substring(end);
}

function blinkCode(editor, range) {
    var marker = editor.getSession().addMarker(range, 'editor-code-blink', true);
    setTimeout(function() {
        editor.getSession().removeMarker(marker);
    }, 500);
}

var AppView = (function(){
    function AppView() {
        var self = this;
        var app_view = this;
        
        this.$el = $('.wrapper').first();
        this.sandbox = {
            editor: null, // Initialized later
            bindings: [],
            createElement: function(type, x, y, w, h, text, clicks) {
                clicks = clicks || 0;
                var $btn = $('<button data-clicks="' + clicks + '">' + text + ': ' + clicks + '</button>');
                $btn.css({
                    'position': 'absolute',
                    'left': x,
                    'top': y,
                    'width': w,
                    'height': h
                });
                app_view.$el.find('.output').append($btn);
                return $btn;
            },
            makeWorld2Code: function(editor, expression_ast, world_object) {
                var binding = new World2Code(editor, expression_ast, world_object);
                this.bindings.push(binding);
                $(world_object).on('click', function() {
                    app_view.ignoreChangeEvents = true;
                    
                    var arg_pos_start = binding.ast.arguments[6].loc.start;
                    var arg_pos_end = binding.ast.arguments[6].loc.end;
                    
                    var replace_range = new (require('ace/range').Range)(arg_pos_start.line - 1, arg_pos_start.column, arg_pos_end.line - 1, arg_pos_end.column);
                    
                    
                    var new_clicks_arg = editor.getSession().getDocument().getTextRange(replace_range) + ' + 1';
                    // TODO: Too ugly, needs actual constant folding. Or not.
                    var simplifiable_ops = {
                        '+': function(a, b) { return a + b },
                        '-': function(a, b) { return a - b }
                    };
                    var simplifiable_binary_op_regex = /([0-9]+)\s*([\+\-])\s*([0-9]+)/ig;
                    function simplifyMatch(match, lhs_match, op, rhs_match) {
                        var lhs = parseInt(lhs_match);
                        var rhs = parseInt(rhs_match);
                        if (!isFinite(lhs) || !isFinite(rhs)) return match;
                        if (!simplifiable_ops[op]) return match;
                        return simplifiable_ops[op](lhs, rhs).toString();
                    }
                    new_clicks_arg = new_clicks_arg.replace(simplifiable_binary_op_regex, simplifyMatch);
                    
                    binding.editor.getSession().replace(replace_range, new_clicks_arg.toString());
                    var blink_range = replace_range.clone();
                    blink_range.end.column = blink_range.start.column + new_clicks_arg.toString().length;
                    blinkCode(binding.editor, blink_range);
                    app_view.ignoreChangeEvents = false;
                    app_view.onCodeChanged();
                });
            }
        };
        // Init ractive
        this.ractive = new Ractive({
            el: this.$el[0],
            template: $('[data-define-template="main"]').html(),
            data: {
                errors: []
            }
        });
        
        var onCodeChanged = this.onCodeChanged.bind(this);
        
        // Init plugins
        this.$el.find('.ace-editor').each(function() {
            var editor = ace.edit(this);
            editor.setOptions({
                minLines: 15,
                maxLines: 15
            });
            editor.getSession().setMode(Settings.editor.languageMode);
            editor.setTheme(Settings.editor.theme);
            editor.getSession().on('change', onCodeChanged);
            editor.getSession().on('input', onCodeChanged);
            $(this).css('font-size', Settings.editor.fontSize);
            $(this).data('ace-editor', editor);
        });
        
        this.sandbox.editor = this.$el.find('.ace-editor').first().data('ace-editor');
        
        // Init demo
        this.sandbox.editor.setValue("for (var i = 0; i < 3; ++i) {\n    createElement('button', 10, i * 40, 80, 40, 'Butts, clicks', i + 0);\n}\ncreateElement('button', 100, 0, 80, 40, 'Another butt', 0);");
        this.onCodeChanged();
    }
    
    AppView.prototype = {
        constructor: AppView,
        onCodeChanged: function() {
            //console.log('Changed!');
            if (this.ignoreChangeEvents) { /*console.log('ignored!');*/ return; }
            this.ignoreChangeEvents = true;
            // Will work only for one editor on page, but should do
            try {
                var editor = this.$el.find('.ace-editor').first().data('ace-editor');
                this.lastCode = editor.getValue();
                var ast = esprima.parse(editor.getValue(), {loc: true});
                /*var original_beautified_code = escodegen.generate(ast);
                if (original_beautified_code !== lastCode) {
                    editor.setValue(original_beautified_code);
                }*/
                decorated_ast = decorateAST(ast, ASTToDecorators);
                var code = escodegen.generate(decorated_ast);
                //console.log(code);
                this.$el.find('.output').empty();
                executeJS(code, this.sandbox);
                this.ractive.set('errors', []);
            } catch(ex) {
                this.ractive.set('errors', [{
                    text: ex.description
                }]);
                //throw ex;
            }
            this.ignoreChangeEvents = false;
        }
    };
    
    return AppView;    
})();

var Controllers = {
    'all': {
        onInit: function() {
            var self = this;
            this.appView = new AppView();
            
            console.log('Initialized!');
        }
    }
};

function test() {
    var ast = esprima.parse($('.ace-editor:visible').first().data('ace-editor').getValue());
    decorated_ast = decorateAST(ast, ASTToDecorators);
    var code = escodegen.generate(decorated_ast);
    console.log(code);
}

$(document).ready(function() {
    function runController(controller_name) {
        if (typeof controller_name === 'string' && Controllers[controller_name]) {
            if (typeof Controllers[controller_name].onInit === 'function') {
                Controllers[controller_name].onInit();
            }
        }
    }
    
    runController('all');
    runController($(document.body).attr('data-controller'));
});